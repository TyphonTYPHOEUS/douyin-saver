"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowDown, ArrowUp, Check, CircleAlert, Clapperboard, Film, LoaderCircle, Music2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { extractLinks, normalizeLink } from "@/lib/douyin/links";
import { receiveVideo, peekReceived, pinReceived, MediaRequestError, isMediaServiceBlocked } from "@/lib/douyin/receive";
import type { Job } from "@/lib/douyin/types";
import { EDIT_HISTORY_KEY, EDIT_HISTORY_LIMIT, distinctContentIds, safeName, uniqueFilename } from "@/lib/edit/model";
import type { RenderResult, RenderProgress } from "@/lib/edit/types";

type Source = { jobId: string; url: string };
type Batch = { id: string; name: string; sources: Source[]; selection: string[]; explicitSelection: boolean; status: "waiting" | "preparing" | "rendering" | "verifying" | "ready" | "failed" | "cancelled" | "stale"; createdAt: number; message?: string; summary?: { filename: string; duration: number; bytes: number } };
type Output = { result: RenderResult; url: string; filename: string };
type Props = { jobs: Job[]; loaded: boolean; visible: boolean; servicePaused: boolean; enqueueLinks: (urls: string[]) => string[]; retryJob: (job: Job) => void; onBusy: (busy: boolean) => void; onSourceRefs: (ids: string[]) => void; onServiceBlocked: (message: string) => void; notify: (message: string) => void };
const POSITIONS = ["左上", "右上", "左下", "右下"];
const BUSY = ["preparing", "rendering", "verifying"];
const STATUS: Record<Batch["status"], string> = { waiting: "等待素材", preparing: "接收素材", rendering: "正在剪辑", verifying: "完整解码校验", ready: "成片就绪", failed: "未完成", cancelled: "已取消", stale: "待重新准备" };
const errorText = (error: unknown) => error instanceof Error ? error.message : "本次处理未完成，请重试。";

/** Restore metadata only. Refresh never starts a transfer or retains a local file. */
function restoreBatches(raw: string | null): Batch[] {
  try {
    const rows: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(rows)) return [];
    return rows.slice(-EDIT_HISTORY_LIMIT).flatMap((row): Batch[] => {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || typeof row.name !== "string" || !Number.isFinite(row.createdAt) || !Array.isArray(row.sources)) return [];
      const seenSources = new Set<string>();
      const sources: Source[] = row.sources.slice(0, 50).flatMap((source: unknown): Source[] => {
        if (!source || typeof source !== "object" || !("jobId" in source) || !("url" in source) || typeof source.jobId !== "string" || typeof source.url !== "string") return [];
        const url = normalizeLink(source.url); const jobId = source.jobId.slice(0, 100); if (!url || !jobId || seenSources.has(jobId)) return []; seenSources.add(jobId); return [{ jobId, url }];
      });
      if (!sources.length) return [];
      const ids = new Set(sources.map(source => source.jobId));
      let name: string; try { name = safeName(row.name); } catch { return []; }
      const selection: string[] = Array.isArray(row.selection) ? row.selection.filter((id: unknown): id is string => typeof id === "string" && ids.has(id)).slice(0, 4) : [];
      let summary: Batch["summary"];
      if (row.summary && typeof row.summary.filename === "string" && Number.isFinite(row.summary.duration) && row.summary.duration > 0 && Number.isFinite(row.summary.bytes) && row.summary.bytes > 0) {
        try { summary = { filename: `${safeName(row.summary.filename)}.mp4`, duration: row.summary.duration, bytes: row.summary.bytes }; } catch { /* Ignore a malformed summary, preserve the batch's valid source references. */ }
      }
      return [{ id: row.id.slice(0, 100), name, sources, selection, explicitSelection: row.explicitSelection === true, status: "stale", createdAt: row.createdAt, summary, message: "刷新后需重新准备素材并选择配乐，已保存的成片不受影响。" }];
    });
  } catch { return []; }
}

export default function EditWorkbench({ jobs, loaded, visible, servicePaused, enqueueLinks, retryJob, onBusy, onSourceRefs, onServiceBlocked, notify }: Props) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [activeId, setActiveId] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [music, setMusic] = useState<Record<string, File>>({});
  const [outputs, setOutputs] = useState<Record<string, Output>>({});
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [sourceMessage, setSourceMessage] = useState("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [includeQueue, setIncludeQueue] = useState<string[]>([]);
  const [draftError, setDraftError] = useState("");
  const running = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const outputsRef = useRef(outputs);
  const usedNames = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { outputsRef.current = outputs; }, [outputs]);
  const active = batches.find(batch => batch.id === activeId);
  const extracted = useMemo(() => extractLinks(text), [text]);
  const chosen = (active?.selection || []).map(id => jobs.find(job => job.id === id)).filter((job): job is Job => !!job);
  const activeBusy = !!active && BUSY.includes(active.status);

  useEffect(() => {
    alive.current = true;
    queueMicrotask(() => {
    try { const saved = restoreBatches(localStorage.getItem(EDIT_HISTORY_KEY)); setBatches(saved); saved.forEach(batch => { if (batch.summary) usedNames.current.add(batch.summary.filename); }); if (saved.length) setActiveId(saved[saved.length - 1].id); }
    catch { notify("浏览器无法保存剪辑记录，当前批次仅在本次打开期间保留。"); }
    setHistoryLoaded(true);
    });
    return () => { alive.current = false; controller.current?.abort(); pinReceived([]); Object.values(outputsRef.current).forEach(output => { URL.revokeObjectURL(output.url); void import("@/lib/edit/client").then(client => client.cleanupRender(output.result.temporaryFile)).catch(() => {}); }); };
    // Read stored metadata once; callbacks do not affect restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;
    try { localStorage.setItem(EDIT_HISTORY_KEY, JSON.stringify(batches.slice(-EDIT_HISTORY_LIMIT).map(batch => ({ id: batch.id, name: batch.name, sources: batch.sources, selection: batch.selection, explicitSelection: batch.explicitSelection, status: batch.status, createdAt: batch.createdAt, summary: batch.summary })))); }
    catch { notify("剪辑记录未能写入浏览器存储，请保留当前页面。"); }
  }, [batches, historyLoaded, notify]);

  useEffect(() => { onSourceRefs(batches.flatMap(batch => batch.sources.map(source => source.jobId))); }, [batches, onSourceRefs]);

  function patch(id: string, update: Partial<Batch>) { setBatches(current => current.map(batch => batch.id === id ? { ...batch, ...update } : batch)); }
  async function removeOutput(id: string) {
    const output = outputsRef.current[id];
    if (!output) return;
    URL.revokeObjectURL(output.url);
    setOutputs(current => { const next = { ...current }; delete next[id]; return next; });
    try { const client = await import("@/lib/edit/client"); await client.cleanupRender(output.result.temporaryFile); } catch { /* A cleanup failure does not invalidate an already saved file. */ }
  }

  // Once a named batch has four distinct parsed works and local music, it runs.
  useEffect(() => {
    if (!historyLoaded || !loaded || running.current) return;
    const batch = batches.find(item => item.status === "waiting" && item.selection.length === 4 && !!music[item.id] && item.selection.every(id => {
      const job = jobs.find(candidate => candidate.id === id);
      return !!job?.video && (!!job.video.mediaToken || !!peekReceived(job.video.contentId)) && (!isMediaServiceBlocked() || !!peekReceived(job.video.contentId));
    }) && distinctContentIds(item.selection.map(id => jobs.find(job => job.id === id)!.video!.contentId)));
    if (!batch) return;
    const selected = batch.selection.map(id => jobs.find(job => job.id === id)!);
    const abort = new AbortController(); controller.current = abort; running.current = batch.id;
    pinReceived(selected.map(job => job.video!.contentId));
    void (async () => {
      try {
        await Promise.resolve();
        abort.signal.throwIfAborted();
        patch(batch.id, { status: "preparing", message: undefined }); setProgress(null); setSourceMessage("正在接收四个素材，已接收的作品会直接复用…");
        const transfers = Promise.all(selected.map((job, index) => receiveVideo(job.video!, update => { if (!abort.signal.aborted && alive.current) setSourceMessage(`${POSITIONS[index]} · ${update.message}`); })));
        const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true }));
        const media = await Promise.race([transfers, cancelled]);
        abort.signal.throwIfAborted();
        onBusy(true);
        patch(batch.id, { status: "rendering" });
        const client = await import("@/lib/edit/client");
        const result = await client.renderBatch({ id: batch.id, name: batch.name, videos: media.map(item => item.blob), music: music[batch.id] }, update => { if (alive.current && !abort.signal.aborted) { setProgress(update); patch(batch.id, { status: update.phase === "verifying" ? "verifying" : "rendering" }); } }, abort.signal);
        if (abort.signal.aborted || !alive.current) { await client.cleanupRender(result.temporaryFile); abort.signal.throwIfAborted(); return; }
        if (result.verification !== "full_decode") throw new Error("成片未通过完整解码校验，请重试。");
        const filename = uniqueFilename(batch.name, usedNames.current); usedNames.current.add(filename);
        const output = { result, url: URL.createObjectURL(result.file), filename };
        setOutputs(current => ({ ...current, [batch.id]: output }));
        patch(batch.id, { status: "ready", summary: { filename, duration: result.duration, bytes: result.bytes }, message: "成片已通过完整音视频解码校验，可以预览和保存。" });
        notify(`「${batch.name}」已剪好，可以预览并保存成片。`);
      } catch (error) {
        if (error instanceof MediaRequestError && error.detail.serviceBlocked) onServiceBlocked(error.message);
        if (alive.current) patch(batch.id, { status: abort.signal.aborted ? "cancelled" : "failed", message: abort.signal.aborted ? "已取消，接收成功的素材仍可复用。" : errorText(error) });
      } finally {
        running.current = null; controller.current = null; onBusy(false); if (alive.current) { setProgress(null); setSourceMessage(""); }
      }
    })();
    // One serial render uses a snapshot of the batch and music; UI edits are locked while running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches, jobs, music, loaded, historyLoaded, servicePaused]);

  useEffect(() => {
    if (!running.current) pinReceived((active?.selection || []).flatMap(id => {
      const contentId = jobs.find(job => job.id === id)?.video?.contentId; return contentId ? [contentId] : [];
    }));
  }, [active, jobs]);

  function createBatch(createdAt: number) {
    setDraftError("");
    if (batches.length >= EDIT_HISTORY_LIMIT) { setDraftError("剪辑记录已达 200 个，请先清除不需要的批次。"); return; }
    let clean: string; try { clean = safeName(name); } catch { setDraftError("请先给成片起一个名字。"); return; }
    if (extracted.overflow) { setDraftError("每次最多加入 50 个链接，请分批补充。"); return; }
    const fromQueue = includeQueue.map(id => jobs.find(job => job.id === id)).filter((job): job is Job => !!job);
    const urls = [...new Set([...extracted.links, ...fromQueue.map(job => job.url)])];
    if (!urls.length) { setDraftError("请粘贴作品链接，或选择下载队列中的素材。"); return; }
    if (urls.length > 50) { setDraftError("每个批次最多保留 50 个候选作品。"); return; }
    const ids = enqueueLinks(urls); if (ids.length !== urls.length) { setDraftError("下载队列已满，请先清理不需要的任务。"); return; }
    const id = crypto.randomUUID();
    const batch: Batch = { id, name: clean, sources: ids.map((jobId, i) => ({ jobId, url: urls[i] })), selection: ids.length <= 4 ? ids : [], explicitSelection: ids.length > 4, status: "waiting", createdAt };
    setBatches(current => [...current, batch].slice(-EDIT_HISTORY_LIMIT)); setActiveId(id); setText(""); setName(""); setIncludeQueue([]); notify("批次已建立。选择本地配乐后，四个不同作品准备好就会自动剪辑。");
  }

  function append() {
    if (!active || activeBusy || !extracted.links.length) return;
    if (extracted.overflow) { setDraftError("每次最多加入 50 个链接。"); return; }
    const fresh = extracted.links.filter(url => !active.sources.some(source => source.url === url));
    if (active.sources.length + fresh.length > 50) { setDraftError("每个批次最多保留 50 个候选作品。"); return; }
    const ids = enqueueLinks(fresh); if (ids.length !== fresh.length) { setDraftError("队列已满，请先清理下载任务。"); return; }
    const sources = [...active.sources, ...ids.map((jobId, i) => ({ jobId, url: fresh[i] }))];
    const explicitSelection = active.explicitSelection || sources.length > 4;
    void removeOutput(active.id);
    patch(active.id, { sources, explicitSelection, selection: explicitSelection ? [] : sources.map(source => source.jobId), status: "waiting", summary: undefined, message: undefined }); setText(""); setDraftError("");
  }

  function prepareAgain() {
    if (!active || activeBusy) return;
    const ids = enqueueLinks(active.sources.map(source => source.url));
    if (ids.length !== active.sources.length) { notify("下载队列已满，请先清理部分任务。"); return; }
    // A ticket may be nonempty but expired: preparing again reparses uncached works.
    // Cached sources keep their bytes and are never requested again just for a fresh ticket.
    for (const id of ids) {
      const job = jobs.find(item => item.id === id);
      if (job && (!job.video || !peekReceived(job.video.contentId))) retryJob(job);
    }
    const selection = active.selection.map(id => ids[active.sources.findIndex(source => source.jobId === id)]).filter(Boolean);
    void removeOutput(active.id);
    patch(active.id, { sources: active.sources.map((source, i) => ({ ...source, jobId: ids[i] })), selection, status: "waiting", summary: undefined, message: undefined });
  }

  function toggleSource(id: string) {
    if (!active || activeBusy || active.status === "stale") return;
    const selection = active.selection.includes(id) ? active.selection.filter(item => item !== id) : active.selection.length < 4 ? [...active.selection, id] : active.selection;
    void removeOutput(active.id); patch(active.id, { selection, explicitSelection: true, status: "waiting", summary: undefined, message: undefined });
  }
  function move(index: number, step: number) {
    if (!active || activeBusy) return; const selection = [...active.selection]; const other = index + step;
    if (other < 0 || other >= selection.length) return;
    [selection[index], selection[other]] = [selection[other], selection[index]];
    void removeOutput(active.id); patch(active.id, { selection, status: "waiting", summary: undefined, message: undefined });
  }
  async function deleteBatch() {
    if (!active || activeBusy) return;
    await removeOutput(active.id); const rest = batches.filter(batch => batch.id !== active.id); setBatches(rest); setActiveId(rest[rest.length - 1]?.id || "");
    setMusic(current => { const next = { ...current }; delete next[active.id]; return next; });
  }
  function saveOutput() {
    if (!active) return; const output = outputs[active.id]; if (!output) return;
    const link = document.createElement("a"); link.href = output.url; link.download = output.filename; document.body.appendChild(link); link.click(); link.remove();
    patch(active.id, { message: "已发起浏览器保存，请在浏览器下载列表中确认文件。" });
  }
  async function saveSources() {
    if (!active || activeBusy) return;
    for (const job of chosen) {
      if (!job.video) continue;
      try {
        const media = await receiveVideo(job.video);
        const url = URL.createObjectURL(media.blob); const filename = uniqueFilename(`${active.name}_douyin_${job.video.contentId}`, usedNames.current); usedNames.current.add(filename);
        const link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (error) { if (error instanceof MediaRequestError && error.detail.serviceBlocked) onServiceBlocked(error.message); notify(errorText(error)); return; }
    }
    notify("已发起原素材保存，请允许浏览器下载多个文件。");
  }

  async function cleanTemporaryFiles() {
    setCleaning(true);
    try {
      const client = await import("@/lib/edit/client");
      const removed = await client.cleanupInactiveRenders();
      notify(removed ? `已清理 ${removed} 个遗留临时成片，当前打开的成片会保留。` : "没有需要清理的遗留临时成片。");
    } catch (error) { notify(errorText(error)); }
    finally { setCleaning(false); }
  }

  const output = active ? outputs[active.id] : undefined;
  const distinct = new Set(chosen.flatMap(job => job.video ? [job.video.contentId] : [])).size;
  return <section className="edit-workbench" hidden={!visible} aria-label="自动剪辑与配乐">
    <div className="compose-layout edit-compose"><div className="compose-card"><div className="section-heading"><span className="section-number">01</span><h2>建立一个剪辑批次</h2><span className="subtle-badge">浏览器本地处理</span></div>
      <label className="edit-field" htmlFor="edit-name">成片名称<input id="edit-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="例如：今日舞蹈灵感" /></label>
      <label className="sr-only" htmlFor="edit-links">剪辑素材的抖音分享链接</label><div className="input-wrap"><textarea id="edit-links" value={text} onChange={event => setText(event.target.value)} maxLength={100_000} placeholder={"粘贴四个作品链接或完整分享文案…\n不足四个可以先建立批次，稍后补充。"} /></div>
      <div className="input-meta"><span><Film size={14} />识别到 {extracted.links.length} 条链接 · 按粘贴顺序排列四格</span></div>
      {jobs.length > 0 && <details className="edit-queue-picker"><summary>或从下载队列选择素材（已选 {includeQueue.length}）</summary><div>{jobs.filter(job => job.status !== "duplicate").slice().reverse().map(job => <label key={job.id}><input type="checkbox" checked={includeQueue.includes(job.id)} onChange={() => setIncludeQueue(current => current.includes(job.id) ? current.filter(id => id !== job.id) : [...current, job.id])} /><span>{job.video?.title || job.url}</span></label>)}</div></details>}
      {draftError && <p className="input-error" role="alert">{draftError}</p>}
      <div className="compose-footer"><span className="edit-fine">每批四个不同作品，不会自动混入其他素材</span><button className="primary" onClick={event => createBatch(event.timeStamp > 1e12 ? event.timeStamp : performance.timeOrigin + event.timeStamp)} disabled={!loaded || !historyLoaded}><Plus size={16} />建立批次</button></div>
      {active && !activeBusy && extracted.links.length > 0 && <button className="edit-append text-button" onClick={append}><Plus size={14} />将这些链接补充到「{active.name}」</button>}
    </div><aside className="how-card"><div className="how-heading"><Clapperboard size={18} /><span>四格，一起播放</span></div><h3>素材就绪，<br />自动剪好配乐。</h3><ol><li><span>1</span><div><b>命名并选四个作品</b><p>左上、右上、左下、右下</p></div></li><li><span>2</span><div><b>选择自己的配乐</b><p>视频和音乐都留在浏览器中</p></div></li><li><span>3</span><div><b>预览并保存成片</b><p>9:16 · 1440 × 2560 · 60 fps</p></div></li></ol><p className="edit-fine">短素材循环至最长素材结束，原声静音，配乐从头播放。剪辑时请保持页面打开。</p></aside></div>

    <section className="edit-batches"><div className="queue-heading"><div className="section-heading"><span className="section-number">02</span><h2>剪辑批次</h2><span className="queue-total">{batches.length}</span></div><button className="text-button" disabled={cleaning || batches.some(batch => BUSY.includes(batch.status))} onClick={cleanTemporaryFiles}>{cleaning ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}清理遗留临时文件</button></div>
      {!batches.length ? <div className="empty-state edit-empty"><Clapperboard size={30} /><h3>给下一支成片起个名字</h3><p>建立批次后，选好配乐，剩下的交给拾影。</p></div> : <><div className="edit-batch-tabs" role="tablist" aria-label="选择剪辑批次">{batches.map(batch => <button key={batch.id} role="tab" aria-selected={activeId === batch.id} className={activeId === batch.id ? "selected" : ""} onClick={() => setActiveId(batch.id)}>{batch.name}<small>{STATUS[batch.status]}</small></button>)}</div>
      {active && <div className="edit-batch-body"><div className="edit-batch-heading"><div><h3>{active.name}</h3><p>{STATUS[active.status]} · 已选 {active.selection.length}/4 个位置 · {distinct} 个不同作品</p></div><div className="queue-actions">{activeBusy ? <button className="secondary" onClick={() => { controller.current?.abort(); patch(active.id, { message: "正在取消…" }); }}><X size={14} />取消本次处理</button> : <><button className="text-button" onClick={prepareAgain}><RefreshCw size={14} />重新准备</button><button className="text-button" onClick={deleteBatch}><Trash2 size={14} />清除此批次</button></>}</div></div>
        {active.status === "stale" && <div className="paused-note"><CircleAlert size={16} />{active.message}</div>}
        <div className="edit-grid">{POSITIONS.map((position, index) => { const job = jobs.find(item => item.id === active.selection[index]); return <div key={position} className="edit-slot"><div className="edit-slot-top"><b>{position}</b><span>{String(index + 1).padStart(2, "0")}</span></div><Clapperboard size={26} strokeWidth={1.3} /><strong>{job?.video?.title || (job ? "等待解析素材…" : "等待选择素材")}</strong><small>{job?.video ? `@${job.video.author} · ${job.video.contentId}` : job?.url || "按顺序选择下方候选作品"}</small><div className="edit-slot-actions"><button className="icon-button" aria-label={`${position}素材向前移动`} disabled={activeBusy || !job || index === 0 || active.status === "stale"} onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button className="icon-button" aria-label={`${position}素材向后移动`} disabled={activeBusy || !job || index >= active.selection.length - 1 || active.status === "stale"} onClick={() => move(index, 1)}><ArrowDown size={14} /></button></div></div>; })}</div>
        <div className="edit-source-list"><h4>候选素材{active.explicitSelection && <span>请明确选择四个不同作品</span>}</h4>{active.sources.map(source => { const job = jobs.find(item => item.id === source.jobId); const chosenIndex = active.selection.indexOf(source.jobId); const duplicate = !!job?.video && active.selection.some(id => id !== job.id && jobs.find(item => item.id === id)?.video?.contentId === job.video?.contentId); return <div className="edit-source-row" key={source.jobId}><label><input type="checkbox" checked={chosenIndex !== -1} disabled={activeBusy || active.status === "stale" || chosenIndex === -1 && (active.selection.length >= 4 || duplicate)} onChange={() => toggleSource(source.jobId)} /><span><strong>{job?.video?.title || source.url}</strong><small>{chosenIndex !== -1 ? `${POSITIONS[chosenIndex]} · ` : ""}{duplicate ? "同一作品已选择，请补充不同作品" : job?.status === "failed" ? job.message : job?.video ? `作品 ${job.video.contentId}` : job?.status === "parsing" ? "正在解析…" : "等待解析"}</small></span></label>{job && !["queued", "parsing", "downloading"].includes(job.status) && !activeBusy && <button className="text-button" onClick={() => retryJob(job)}><RefreshCw size={13} />重新解析</button>}</div>; })}</div>
        {active.selection.length < 4 && <p className="edit-waiting">还需选择 {4 - active.selection.length} 个素材。可在上方粘贴链接并补充到当前批次。</p>}
        {active.selection.length === 4 && chosen.every(job => !!job.video) && distinct < 4 && <p className="input-error">选中的链接中含重复作品，还缺 {4 - distinct} 个不同作品。请取消重复项并补充。</p>}
        <div className="edit-music"><Music2 size={22} /><div><label htmlFor={`music-${active.id}`}>背景音乐</label><p>{music[active.id]?.name || "选择本地音频；四个素材就绪后会自动开始"}</p></div><label className={`secondary file-picker ${activeBusy || active.status === "stale" ? "disabled" : ""}`}>选择配乐<input key={active.id} id={`music-${active.id}`} type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac" disabled={activeBusy || active.status === "stale"} onChange={event => { const file = event.target.files?.[0]; if (!file) return; event.currentTarget.value = ""; setMusic(current => ({ ...current, [active.id]: file })); void removeOutput(active.id); patch(active.id, { status: "waiting", message: undefined, summary: undefined }); }} /></label></div>
        <p className="edit-fine">原声静音 · 保留完整画面和比例 · 配乐 100% 音量 · 无字幕、转场或淡入淡出。音乐不足时会保留素材，提示更换配乐。</p>
        {activeBusy && <div className="edit-progress" role="status" aria-live="polite"><LoaderCircle size={18} className="spin" /><div><strong>{progress?.message || sourceMessage || STATUS[active.status]}</strong>{progress && <progress max={Math.max(1, progress.total)} value={progress.completed} />}</div></div>}
        {active.message && active.status !== "stale" && <p className={`edit-result-message ${active.status === "failed" ? "error" : ""}`} role="status">{active.status === "ready" ? <Check size={16} /> : <CircleAlert size={16} />}{active.message}</p>}
        {["failed", "cancelled"].includes(active.status) && <button className="secondary" onClick={prepareAgain}><RefreshCw size={15} />重试剪辑</button>}
        {output && <div className="edit-output"><video src={output.url} controls playsInline preload="metadata" aria-label={`${active.name}四宫格成片预览`} /><div><span className="eyebrow">YOUR FILM / READY</span><h3>四份灵感，一起播放。</h3><p>{output.filename}</p><p>{output.result.duration.toFixed(2)} 秒 · 完整音视频解码校验通过</p><button className="primary" onClick={saveOutput}><ArrowDownToLine size={17} />保存成片</button><button className="text-button" onClick={saveSources}><ArrowDownToLine size={14} />另存四个原素材</button><small>保存位置由浏览器决定，请在下载列表中确认。</small></div></div>}
        {!output && active.summary && <p className="edit-fine">上次成片：{active.summary.filename} · {active.summary.duration.toFixed(2)} 秒。请在设备下载目录查看。</p>}
      </div>}</>}
    </section>
  </section>;
}
