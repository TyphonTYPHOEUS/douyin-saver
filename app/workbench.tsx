"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronRight, CircleAlert, Clipboard, Clapperboard, Copy, ExternalLink, FileVideo2, FolderClock, CodeXml as Github, HelpCircle, Layers3, Link2, LoaderCircle, LockKeyhole, Pause, Play, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { extractLinks } from "@/lib/douyin/links";
import { HISTORY_KEY, HISTORY_LIMIT, restoreHistory, serializeHistory } from "@/lib/douyin/history";
import { inspectMp4 } from "@/lib/douyin/mp4";
import { MAX_VIDEO_BYTES } from "@/lib/douyin/media";
import type { ApiFailure, Job, JobStatus, ParsedVideo, ParseResponse } from "@/lib/douyin/types";

const REPOSITORY = "https://github.com/TyphonTYPHOEUS/douyin-saver";
const LABELS: Record<JobStatus, string> = { queued: "等待解析", parsing: "正在解析", ready: "待保存", downloading: "正在接收", verified: "已发起保存", failed: "未完成", stale: "待重新解析", duplicate: "重复作品" };
const wait = (duration: number) => new Promise(resolve => setTimeout(resolve, duration));
const sizeText = (bytes: number) => bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "大小待确认";
const durationText = (seconds: number) => seconds > 0 ? `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}` : "";

class RequestError extends Error {
  detail: ApiFailure;
  constructor(detail: ApiFailure) { super(detail.error); this.detail = detail; }
}

async function post(path: string, body: unknown): Promise<ParseResponse> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new RequestError({ error: typeof result.error === "string" ? result.error : "请求未完成，请稍后重试。", code: typeof result.code === "string" ? result.code : "REQUEST_FAILED", serviceBlocked: result.serviceBlocked === true, retryAfter: typeof result.retryAfter === "number" ? result.retryAfter : undefined });
  if (result.status !== "ready" && result.status !== "pending") throw new Error("网站返回了无法识别的结果，请稍后重试。");
  return result as ParseResponse;
}

function Modal({ kind, close, autoSave, setAutoSave }: { kind: string; close: () => void; autoSave: boolean; setAutoSave: (value: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }} className="dialog">
    <div className="dialog-heading"><span className="eyebrow">SHIYING / {kind === "help" ? "GUIDE" : kind === "settings" ? "PREFERENCES" : "PRIVACY"}</span><button className="icon-button" onClick={close} aria-label="关闭弹窗"><X size={20} /></button></div>
    {kind === "help" ? <>
      <h2>从分享，到你的收藏。</h2>
      <ol className="guide-list"><li><b>01</b><div><strong>复制分享文案</strong><p>在抖音作品的分享菜单中选择「复制链接」。完整文案、短链接和作品链接都可以。</p></div></li><li><b>02</b><div><strong>粘贴并加入队列</strong><p>一次最多识别 50 条不同链接，自动去掉重复项。队列逐条解析，遇到服务限流会自动暂停。</p></div></li><li><b>03</b><div><strong>点击保存视频</strong><p>收到文件并通过 MP4 结构校验后，交给浏览器保存。批量保存时，请允许浏览器下载多个文件。</p></div></li></ol>
      <div className="note"><CircleAlert size={17} /><p>网站不能直接写入你指定的文件夹，保存位置由浏览器设置决定。手机上可在浏览器的下载列表中找到文件。请仅保存你有权使用的内容。</p></div>
      <p className="dialog-footnote">当前支持公开的视频作品和 200 MB 以内的文件。图集、直播和私密作品暂不支持。公共解析服务可能限流；失败时会保留已完成的记录。</p>
    </> : kind === "settings" ? <>
      <h2>按你的习惯来。</h2>
      <label className="setting-line"><div><strong>解析后自动保存</strong><p>逐条接收并校验文件，然后发起浏览器保存。</p></div><input type="checkbox" checked={autoSave} onChange={event => setAutoSave(event.target.checked)} /><span className="switch" aria-hidden="true" /></label>
      <div className="note"><ArrowDownToLine size={17} /><p>开启后，浏览器可能询问是否允许下载多个文件。关闭标签页会停止当前任务。</p></div>
      <p className="dialog-footnote">记录只保存在当前浏览器，最多保留最近 200 项。刷新后需要重新解析未保存的作品，以获取新的下载地址。</p>
    </> : <>
      <h2>你的记录，留在你这里。</h2>
      <div className="privacy-points"><p><ShieldCheck size={20} /><span><strong>不需要抖音账号</strong>不读取你的抖音密码、浏览器 Cookie 或本地视频。</span></p><p><Link2 size={20} /><span><strong>只提交作品链接</strong>分享文案在浏览器中提取为链接，再交给解析服务处理。公共演示服务为 demo.douyin.wtf。</span></p><p><FolderClock size={20} /><span><strong>记录保存在浏览器</strong>本站不建立下载记录数据库。媒体经网站转发，文件会在你的浏览器中接收和校验。</span></p></div>
      <p className="dialog-footnote">解析服务和网站托管服务可能记录网络请求；其数据处理规则由相应服务方决定。开源部署者可以配置自己的解析服务。MP4 结构校验不等同于完整音视频解码。</p>
    </>}
    <button className="primary dialog-done" onClick={close}>知道了<Check size={17} /></button>
  </dialog>;
}

export default function Workbench() {
  const [view, setView] = useState<"workbench" | "history">("workbench");
  const [text, setText] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [autoSave, setAutoSave] = useState(false);
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState("");
  const [filter, setFilter] = useState("all");
  const [modal, setModal] = useState("");
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<Job | null>(null);
  const running = useRef(false);
  const saving = useRef(new Set<string>());
  const jobsRef = useRef(jobs);
  const settingsRef = useRef(autoSave);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  jobsRef.current = jobs;
  settingsRef.current = autoSave;
  const extracted = useMemo(() => extractLinks(text), [text]);
  const counts = useMemo(() => ({ ready: jobs.filter(job => job.status === "ready").length, verified: jobs.filter(job => job.status === "verified").length, failed: jobs.filter(job => job.status === "failed").length, active: jobs.filter(job => ["queued", "parsing", "downloading"].includes(job.status)).length }), [jobs]);
  const visible = [...jobs].reverse().filter(job => filter === "all" || filter === "ready" && job.status === "ready" || filter === "verified" && job.status === "verified" || filter === "failed" && ["failed", "stale"].includes(job.status));

  useEffect(() => {
    try {
      setJobs(restoreHistory(localStorage.getItem(HISTORY_KEY)));
      setAutoSave(localStorage.getItem("douyin-saver.autosave") === "true");
    } catch { setNotice("当前浏览器无法保存记录，关闭页面后记录可能丢失。"); }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(HISTORY_KEY, serializeHistory(jobs)); localStorage.setItem("douyin-saver.autosave", String(autoSave)); }
    catch { setNotice("浏览器存储不可用，当前记录只在本次打开期间保留。"); }
  }, [jobs, loaded, autoSave]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 4500); return () => clearTimeout(timer); }, [toast]);

  function update(id: string, patch: Partial<Job>) {
    setJobs(current => {
      const next = current.map(job => job.id === id ? { ...job, ...patch } : job);
      jobsRef.current = next;
      return next;
    });
  }

  async function saveVideo(job: Job, video: ParsedVideo | undefined = job.video): Promise<boolean> {
    if (!video?.mediaToken || saving.current.has(job.id)) return false;
    if (saving.current.size >= 2) { setToast("已有两个视频正在接收，请稍后继续。"); return false; }
    saving.current.add(job.id);
    update(job.id, { status: "downloading", progress: 0, message: "正在接收视频文件…" });
    try {
      const response = await fetch(`/api/media?token=${encodeURIComponent(video.mediaToken)}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as Partial<ApiFailure>;
        throw new RequestError({ error: result.error || "视频传输失败，请重新解析。", code: result.code || "MEDIA_ERROR", serviceBlocked: result.serviceBlocked === true });
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("浏览器无法接收视频文件。");
      const expectedLength = Number(response.headers.get("content-length") || 0);
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let received = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_VIDEO_BYTES) { await reader.cancel(); throw new Error("视频超过 200 MB，已停止接收。"); }
        chunks.push(value);
        update(job.id, { progress: expectedLength ? Math.min(99, Math.round(received / expectedLength * 100)) : undefined, message: `已接收 ${sizeText(received)}` });
      }
      if (expectedLength && received !== expectedLength) throw new Error("视频传输不完整，请重新解析。");
      update(job.id, { message: "正在校验 MP4 文件…" });
      const blob = new Blob(chunks, { type: "video/mp4" });
      const info = inspectMp4(await blob.arrayBuffer(), video.bytes || undefined);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl; link.download = `douyin_${video.contentId}.mp4`; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      update(job.id, { status: "verified", progress: 100, video: { ...video, width: info.width, height: info.height, duration: info.duration, bytes: received }, message: "MP4 结构校验通过，已交给浏览器保存" });
      setToast("视频已校验，请在浏览器下载列表中查看保存结果。");
      return true;
    } catch (error) {
      update(job.id, { status: "failed", message: error instanceof Error ? error.message : "保存未完成，请重试。", progress: undefined });
      if (error instanceof RequestError && error.detail.serviceBlocked) { setPaused(true); setNotice(error.message); }
      return false;
    } finally { saving.current.delete(job.id); }
  }

  useEffect(() => {
    if (!loaded || paused || running.current) return;
    const next = jobs.find(job => job.status === "queued");
    if (!next) return;
    running.current = true;
    update(next.id, { status: "parsing", message: "正在获取作品信息…" });
    void (async () => {
      try {
        let result = await post("/api/parse", { url: next.url });
        const deadline = Date.now() + 65_000;
        while (result.status === "pending" && Date.now() < deadline) {
          update(next.id, { message: "解析服务处理中，正在等待同一任务…" });
          await wait(3000);
          result = await post("/api/tasks", { taskToken: result.taskToken });
        }
        if (result.status !== "ready") throw new RequestError({ error: "解析任务等待超时，队列已暂停，请稍后重试。", code: "TASK_TIMEOUT", serviceBlocked: true });
        const video = result.video;
        const duplicate = jobsRef.current.find(job => job.id !== next.id && job.video?.contentId === video.contentId && !["failed", "duplicate"].includes(job.status));
        if (duplicate) update(next.id, { status: "duplicate", video, message: "该作品已在队列或历史记录中" });
        else {
          update(next.id, { status: "ready", video, message: "作品已就绪，点击保存即可接收视频" });
          if (settingsRef.current) await saveVideo(next, video);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "解析失败，请稍后重试。";
        update(next.id, { status: "failed", message });
        if (!(error instanceof RequestError) || error.detail.serviceBlocked) { setPaused(true); setNotice(message); }
      } finally { running.current = false; setTick(value => value + 1); }
    })();
    // The worker reads current records/settings from refs; tick schedules the next item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, loaded, paused, tick]);

  function addJobs() {
    if (!extracted.links.length) { setToast("还没有识别到抖音视频链接。"); inputRef.current?.focus(); return; }
    if (extracted.overflow) { setToast("单次最多 50 条，请将剩余链接分批提交。"); return; }
    const existing = new Set(jobs.filter(job => job.status !== "failed").map(job => job.url));
    const fresh = extracted.links.filter(url => !existing.has(url));
    const active = jobs.filter(job => ["queued", "parsing", "downloading", "ready"].includes(job.status));
    if (active.length + fresh.length > HISTORY_LIMIT) { setToast("当前待处理任务较多，请先保存或移除部分任务。"); return; }
    const room = HISTORY_LIMIT - active.length - fresh.length;
    const inactive = room > 0 ? jobs.filter(job => !active.includes(job)).slice(-room) : [];
    const additions: Job[] = fresh.map(url => ({ id: crypto.randomUUID(), url, status: "queued", addedAt: Date.now() }));
    const nextJobs = [...inactive, ...active, ...additions].slice(-HISTORY_LIMIT);
    setJobs(nextJobs); jobsRef.current = nextJobs;
    const skipped = extracted.links.length - fresh.length + extracted.duplicates;
    setToast(fresh.length ? `已加入 ${fresh.length} 条作品${skipped ? `，跳过 ${skipped} 条重复链接` : ""}。` : "这些链接已在队列中，可在下方查看。");
    if (fresh.length) { setText(""); setFilter("all"); }
  }

  async function paste() {
    try { const content = await navigator.clipboard.readText(); setText(content.slice(0, 100_000)); inputRef.current?.focus(); if (!content) setToast("剪贴板还是空的。"); }
    catch { setToast("浏览器未允许读取剪贴板，请直接在输入框中粘贴。"); inputRef.current?.focus(); }
  }

  function retry(job: Job) {
    if (running.current && job.status === "parsing" || saving.current.has(job.id)) return;
    update(job.id, { status: "queued", video: undefined, progress: undefined, message: undefined });
    setPaused(false); setNotice("");
  }

  async function saveAll() {
    for (const job of jobsRef.current.filter(item => item.status === "ready")) {
      if (!await saveVideo(job)) break;
    }
  }

  function clearRecords() {
    if (!window.confirm("清空此浏览器的任务记录？已保存到设备的视频不会受影响。")) return;
    setJobs([]); jobsRef.current = []; setFilter("all"); setNotice(""); setPaused(false); setToast("记录已清空。");
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="拾影首页"><span className="brand-symbol"><Clapperboard size={24} strokeWidth={1.6} /></span><span>拾影<small>SHIYING</small></span></a>
      <div className="workspace-label">你的灵感工作空间</div>
      <nav className="side-nav" aria-label="主导航"><button className={view === "workbench" ? "active" : ""} onClick={() => { setView("workbench"); setFilter("all"); }}><Layers3 size={18} />下载工作台<ChevronRight size={15} className="nav-arrow" /></button><button className={view === "history" ? "active" : ""} onClick={() => { setView("history"); setFilter("all"); }}><FolderClock size={18} />本地记录<span className="nav-count">{jobs.length}</span></button></nav>
      <div className="sidebar-guide"><span className="mini-label">KEEP WHAT INSPIRES YOU</span><div className="line-art" aria-hidden="true"><span /><span /><span /><Clapperboard size={34} strokeWidth={1} /></div><p>让偶然遇见的好内容，<br />成为随时可取的灵感。</p><button onClick={() => setModal("help")}>三步开始<ArrowUpRight size={14} /></button></div>
      <div className="sidebar-bottom"><button onClick={() => setModal("help")}><HelpCircle size={17} />使用指南</button><button onClick={() => setModal("settings")}><Settings2 size={17} />下载偏好</button><div className="version"><span className="status-dot" />开源的小工具<span>v0.1.0</span></div></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>工作空间</span><ChevronRight size={13} /><strong>{view === "workbench" ? "下载工作台" : "本地记录"}</strong></div><a className="github-link" href={REPOSITORY} target="_blank" rel="noreferrer"><Github size={17} /><span>GitHub 开源</span><ArrowUpRight size={13} /></a></header>
      <main>
        <div className="page-heading"><div><p className="eyebrow"><span className="short-line" />{view === "workbench" ? "A LITTLE TOOL FOR YOUR INSPIRATION" : "YOUR COLLECTION, ON THIS BROWSER"}</p><h1>{view === "workbench" ? <>把好内容，<span>留在手边。</span></> : <>每一次收藏，<span>都有迹可循。</span></>}</h1><p className="page-description">{view === "workbench" ? "粘贴抖音分享链接，把喜欢的视频，存进自己的灵感库。" : "这里保留此浏览器最近的 200 条记录，已保存文件请到设备的下载目录查看。"}</p></div><div className="heading-stamp" aria-hidden="true"><Clapperboard size={29} strokeWidth={1.2} /><span>COLLECT<br />YOUR INSPIRATION</span><b>↙</b></div></div>

        <div className="stats-strip"><div><span className="stat-icon"><Layers3 size={18} /></span><div><strong>{jobs.length.toString().padStart(2, "0")}</strong><span>全部作品</span></div></div><div><span className="stat-icon"><ArrowDownToLine size={18} /></span><div><strong>{counts.ready.toString().padStart(2, "0")}</strong><span>等待保存</span></div></div><div><span className="stat-icon green"><CheckCheck size={18} /></span><div><strong>{counts.verified.toString().padStart(2, "0")}</strong><span>已发起保存</span></div></div><button className="privacy-link" onClick={() => setModal("privacy")}><LockKeyhole size={14} /><span>记录留在你的浏览器</span><ArrowUpRight size={13} /></button></div>

        {view === "workbench" && <section className="compose-layout" aria-label="添加视频任务"><div className="compose-card"><div className="section-heading"><span className="section-number">01</span><h2>从一个链接开始</h2><span className="subtle-badge">支持批量粘贴</span></div><label className="sr-only" htmlFor="share-text">抖音分享文案或视频链接</label><div className="input-wrap"><textarea ref={inputRef} id="share-text" value={text} onChange={event => setText(event.target.value)} maxLength={100_000} placeholder={"粘贴抖音视频链接，或直接粘贴完整分享文案…\n\n多条链接也可以，一次最多 50 条。"} spellCheck={false} /><button className="paste-button" onClick={paste}><Clipboard size={14} />粘贴剪贴板</button></div><div className="input-meta"><span className={extracted.links.length ? "detected" : ""}><Link2 size={14} />{extracted.links.length ? `识别到 ${extracted.links.length} 条作品链接` : "自动识别链接，无需整理分享文案"}{extracted.duplicates > 0 && ` · 已去重 ${extracted.duplicates} 条`}</span>{text && <button onClick={() => { setText(""); inputRef.current?.focus(); }} aria-label="清空输入"><X size={14} />清空</button>}</div><div className="compose-footer"><label className="auto-save"><input type="checkbox" checked={autoSave} onChange={event => setAutoSave(event.target.checked)} /><span className="checkbox-visual">{autoSave && <Check size={11} />}</span>解析后自动保存</label><button className="primary" onClick={addJobs} disabled={!extracted.links.length || !loaded}>加入下载队列<ArrowRight size={17} /></button></div>{extracted.overflow > 0 && <p className="input-error">超出单次上限 {extracted.overflow} 条，请分批提交。</p>}</div><aside className="how-card"><div className="how-heading"><Sparkles size={17} /><span>小步骤，好收藏</span></div><h3>从分享，<br />到自己的灵感库。</h3><ol><li><span>1</span><div><b>复制链接</b><p>在抖音分享菜单中复制</p></div></li><li><span>2</span><div><b>粘贴文案</b><p>分享文案也能自动识别</p></div></li><li><span>3</span><div><b>保存到本地</b><p>文件校验后，由浏览器保存</p></div></li></ol><button onClick={() => setModal("help")}>查看完整指南<ArrowUpRight size={14} /></button></aside></section>}

        <section className="queue-section" aria-label="下载任务列表"><div className="queue-heading"><div className="section-heading"><span className="section-number">{view === "workbench" ? "02" : "01"}</span><h2>{view === "workbench" ? "你的下载队列" : "此浏览器的记录"}</h2><span className="queue-total">{jobs.length}</span></div><div className="queue-actions">{counts.active > 0 && <button className="text-button" onClick={() => { setPaused(!paused); if (paused) setNotice(""); }}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? "继续队列" : "暂停后续"}</button>}<button className="text-button" onClick={clearRecords} disabled={!jobs.length || counts.active > 0}><Trash2 size={14} />清空记录</button><button className="secondary" onClick={saveAll} disabled={!counts.ready || jobs.some(job => job.status === "downloading")}><ArrowDownToLine size={15} />保存全部{counts.ready > 0 && ` (${counts.ready})`}</button></div></div>
          {notice && <div className="service-notice" role="alert"><CircleAlert size={17} /><p>{notice}</p><button onClick={() => { setPaused(false); setNotice(""); }}><Play size={13} />继续后续任务</button></div>}
          {paused && !notice && <div className="paused-note"><Pause size={14} />后续解析已暂停，正在进行的任务会继续完成。</div>}
          <div className="filter-bar" role="group" aria-label="按任务状态筛选">{[["all", "全部", jobs.length], ["ready", "待保存", counts.ready], ["verified", "已发起保存", counts.verified], ["failed", "未完成", jobs.filter(job => ["failed", "stale"].includes(job.status)).length]].map(([key, label, count]) => <button key={key} className={filter === key ? "selected" : ""} onClick={() => setFilter(String(key))}>{label}<span>{count}</span></button>)}<span className="queue-mode"><span className={`status-dot ${counts.active && !paused ? "busy" : ""}`} />{counts.active && !paused ? "逐条处理中" : paused ? "队列已暂停" : "就绪"}</span></div>
          <div className="queue-body">{!loaded ? <div className="empty-state"><LoaderCircle className="spin" size={24} /><p>正在读取本地记录…</p></div> : !visible.length ? <div className="empty-state"><div className="empty-art" aria-hidden="true"><span className="empty-sheet" /><span className="empty-sheet front"><FileVideo2 size={25} strokeWidth={1.25} /><small>MP4</small></span><span className="empty-plus"><Plus size={13} /></span></div><h3>{jobs.length ? "这里还没有符合条件的作品" : "下一份灵感，从这里开始"}</h3><p>{jobs.length ? "切换其他状态，查看已有任务。" : "把分享链接放进上方输入框，剩下的交给拾影。"}</p>{jobs.length === 0 && <button onClick={() => { setView("workbench"); setTimeout(() => inputRef.current?.focus(), 50); }}><Plus size={14} />添加第一个视频</button>}</div> : <div className="job-list">{visible.map((job, index) => <article className={`job-row status-${job.status}`} key={job.id}><div className="video-tile"><Clapperboard size={23} strokeWidth={1.3} /><span>{durationText(job.video?.duration || 0) || `${(visible.length - index).toString().padStart(2, "0")}`}</span></div><div className="job-content"><div className="job-title-line"><h3>{job.video?.title || (job.status === "parsing" ? "正在寻找这份灵感…" : "抖音视频作品")}</h3><span className={`job-status ${job.status}`}>{["parsing", "downloading"].includes(job.status) && <LoaderCircle size={12} className="spin" />}{job.status === "verified" && <Check size={12} />}{job.status === "failed" && <CircleAlert size={12} />}{LABELS[job.status]}</span></div><div className="job-info">{job.video ? <><span>@{job.video.author}</span><i />{job.video.width > 0 && <span>{job.video.width} × {job.video.height}</span>}<span>{sizeText(job.video.bytes)}</span>{job.video.watermark === false && <span className="clean-label">接口提供无水印</span>}</> : <span className="job-url">{job.url}</span>}</div>{job.status === "downloading" ? <div className="download-progress"><span style={{ width: job.progress === undefined ? "35%" : `${job.progress}%` }} className={job.progress === undefined ? "indeterminate" : ""} /><small>{job.progress === undefined ? job.message : `${job.progress}%`}</small></div> : job.status === "failed" || job.status === "stale" ? <p className="job-error">{job.message}</p> : null}</div><div className="job-actions">{job.status === "ready" && <button className="save-button" aria-label="保存视频" onClick={() => saveVideo(job)}><ArrowDownToLine size={15} /><span>保存视频</span></button>}{["failed", "stale", "verified"].includes(job.status) && <button className="icon-button" onClick={() => retry(job)} title={job.status === "verified" ? "重新解析并保存" : "重新解析"} aria-label="重新解析"><RefreshCw size={16} /></button>}<button className="icon-button detail-button" onClick={() => setSelected(job)} title="作品详情" aria-label="作品详情"><ExternalLink size={16} /></button>{job.status === "queued" && <button className="icon-button" onClick={() => setJobs(current => current.filter(item => item.id !== job.id))} title="移除等待任务" aria-label="移除等待任务"><X size={16} /></button>}</div></article>)}</div>}</div>
          <div className="queue-footnote"><ShieldCheck size={13} /><span>保存前检查 MP4 结构 · 不代表完整解码 · 实际保存结果以浏览器为准</span></div>
        </section>
        <footer className="page-footer"><span>拾影 SHIYING<span className="footer-dot">·</span>为每一次灵感停留</span><div><button onClick={() => setModal("help")}>使用指南</button><button onClick={() => setModal("privacy")}>隐私与数据</button><a href={REPOSITORY} target="_blank" rel="noreferrer">开源项目<ArrowUpRight size={11} /></a></div></footer>
      </main>
    </div>
    {modal && <Modal kind={modal} close={() => setModal("")} autoSave={autoSave} setAutoSave={setAutoSave} />}
    {selected && <Details job={jobs.find(job => job.id === selected.id) || selected} close={() => setSelected(null)} notify={setToast} />}
    {toast && <div className="toast" role="status"><Check size={16} /><span>{toast}</span><button onClick={() => setToast("")} aria-label="关闭提示"><X size={14} /></button></div>}
  </div>;
}

function Details({ job, close, notify }: { job: Job; close: () => void; notify: (message: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  async function copy() {
    try { await navigator.clipboard.writeText(job.url); notify("作品链接已复制。"); }
    catch { notify("复制失败，可以在详情中选中链接手动复制。"); }
  }
  return <dialog ref={ref} className="dialog details-dialog" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="dialog-heading"><span className="eyebrow">COLLECTION / DETAILS</span><button className="icon-button" onClick={close} aria-label="关闭详情"><X size={20} /></button></div><h2>{job.video?.title || "抖音视频作品"}</h2><dl><div><dt>处理状态</dt><dd>{LABELS[job.status]}</dd></div><div><dt>添加时间</dt><dd>{new Date(job.addedAt).toLocaleString("zh-CN")}</dd></div>{job.video && <><div><dt>作品 ID</dt><dd>{job.video.contentId}</dd></div><div><dt>创作者</dt><dd>{job.video.author}</dd></div><div><dt>画面与大小</dt><dd>{job.video.width || "—"} × {job.video.height || "—"} · {sizeText(job.video.bytes)}</dd></div><div><dt>文件校验</dt><dd>{job.status === "verified" ? "MP4 结构校验通过（未进行完整解码）" : "文件保存时校验"}</dd></div></>}<div><dt>作品链接</dt><dd><a href={job.url} target="_blank" rel="noreferrer">{job.url}<ArrowUpRight size={12} /></a></dd></div>{job.message && <div><dt>处理提示</dt><dd>{job.message}</dd></div>}</dl><button className="secondary" onClick={copy}><Copy size={15} />复制作品链接</button></dialog>;
}
