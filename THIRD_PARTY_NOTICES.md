# Third-party notices

The build integration and retained starter support originate from OpenAI Sites. The original MIT copyright and permission notice is retained below and in `build/sites-vite-plugin.LICENSE`.

The application uses React, Vinext, Vite, Cloudflare tooling, Lucide and other packages listed in `package.json` and `package-lock.json`. Their respective licenses remain applicable. Interface fonts DM Sans and Noto Serif SC are requested from Google Fonts and are distributed under the SIL Open Font License by their upstream projects; system fallbacks work without those requests.

DTK (https://douyin.wtf/) is an independent external REST service. Its source code is not included in this repository.

## Browser media processing

The optional browser editor uses **Mediabunny 1.65.2** and **@mediabunny/aac-encoder 1.65.2**, distributed under the Mozilla Public License 2.0. Their unmodified upstream source and license are available at https://github.com/Vanilagy/mediabunny/tree/v1.65.2 and in the installed packages. Application files in this repository remain MIT-licensed; these dependencies retain their own licenses.

The AAC encoder extension includes a reduced FFmpeg build under LGPL-2.1-or-later, without GPL components. Its build scripts, corresponding source references and license notices are provided by the upstream package at https://github.com/Vanilagy/mediabunny/tree/v1.65.2/packages/aac-encoder. The extension is loaded only when a native AAC encoder is unavailable. Native WebCodecs implementations are supplied by the user's browser and operating system.

Playwright is a development-only browser testing dependency, licensed under Apache-2.0. Tests generate their own synthetic media; no personal music or downloaded creator videos are distributed.

## OpenAI build support

MIT License

Copyright (c) 2026 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
