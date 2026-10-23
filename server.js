"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const puppeteer = require("puppeteer-core");

const PORT = Number(process.env.PORT) || 5178;
const HOST = "127.0.0.1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- browser

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const browserPath = BROWSER_CANDIDATES.find((p) => {
  try { return fs.existsSync(p); } catch { return false; }
});

let browserPromise = null;
function getBrowser() {
  if (!browserPath) return null;
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({ executablePath: browserPath, headless: true, args: ["--no-first-run", "--mute-audio"] })
      .then((b) => {
        b.on("disconnected", () => { browserPromise = null; });
        return b;
      })
      .catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

// Runs inside the rendered page: collects every image the page shows or links to.
function collectImagesInPage() {
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?|jfif)(?:[?#]|$)/i;
  const abs = (u) => {
    if (!u) return null;
    try {
      const url = new URL(u.trim(), location.href);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  const largestFromSrcset = (srcset) => {
    if (!srcset) return null;
    let best = null, bestScore = -1;
    srcset.split(",").forEach((part) => {
      const [u, d] = part.trim().split(/\s+/);
      const score = d ? parseFloat(d) * (d.endsWith("x") ? 1000 : 1) : 1;
      if (u && score > bestScore) { best = u; bestScore = score; }
    });
    return best;
  };
  const items = new Map();
  const add = (src, extra) => {
    const url = abs(src);
    if (!url) return;
    const prev = items.get(url);
    if (prev) {
      if (!prev.original && extra.original) prev.original = extra.original;
      if (!prev.alt && extra.alt) prev.alt = extra.alt;
      return;
    }
    items.set(url, Object.assign({ src: url, original: null, alt: "", w: 0, h: 0, kind: "img" }, extra));
  };
  // An <img> inside a card that links to a single image file → that file is the original.
  const findOriginal = (el, self) => {
    const a = el.closest("a[href]");
    if (a && IMG_EXT.test(a.href) && a.href !== self) return a.href;
    // Walk up a few levels; stop at the first ancestor that holds exactly one image <img> and one image link.
    for (let node = el.parentElement, depth = 0; node && node !== document.body && depth < 5; node = node.parentElement, depth++) {
      if (node.querySelectorAll("img").length > 1) return null;
      const links = [...new Set([...node.querySelectorAll("a[href]")].map((l) => abs(l.href)).filter((h) => h && IMG_EXT.test(h) && h !== self))];
      if (links.length === 1) return links[0];
      if (links.length > 1) return null;
    }
    return null;
  };

  document.querySelectorAll("img").forEach((img) => {
    const lazy = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src");
    const src = largestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset")) || img.currentSrc || img.src || lazy;
    const url = abs(src);
    if (!url) return;
    add(url, {
      alt: (img.alt || img.title || "").trim(),
      w: img.naturalWidth || 0,
      h: img.naturalHeight || 0,
      original: findOriginal(img, url),
    });
  });
  document.querySelectorAll("picture source[srcset]").forEach((s) => {
    add(largestFromSrcset(s.getAttribute("srcset")), { kind: "source" });
  });
  document.querySelectorAll("*").forEach((el) => {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") return;
    const re = /url\(["']?([^"')]+)["']?\)/g;
    let m;
    while ((m = re.exec(bg))) add(m[1], { kind: "background" });
  });
  // Image files linked directly (originals not already tied to a thumbnail).
  const linkedOriginals = new Set([...items.values()].map((i) => i.original).filter(Boolean));
  document.querySelectorAll("a[href]").forEach((a) => {
    const h = abs(a.href);
    if (h && IMG_EXT.test(h) && !linkedOriginals.has(h)) add(h, { kind: "link", alt: (a.textContent || "").trim().slice(0, 80) });
  });
  document.querySelectorAll("meta[property='og:image'], meta[name='twitter:image'], link[rel~='icon']").forEach((m) => {
    add(m.getAttribute("content") || m.getAttribute("href"), { kind: "meta" });
  });
  return { title: document.title, items: [...items.values()] };
}

async function scanWithBrowser(url, { scroll, maxRounds }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    // Some SPAs read the hash only on load; make sure it was applied.
    if (new URL(url).hash) await new Promise((r) => setTimeout(r, 300));

    if (scroll) {
      let lastHeight = 0, lastCount = 0, stable = 0;
      for (let i = 0; i < maxRounds && stable < 3; i++) {
        const { height, count } = await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          return { height: document.documentElement.scrollHeight, count: document.images.length };
        });
        await new Promise((r) => setTimeout(r, 700));
        stable = height === lastHeight && count === lastCount ? stable + 1 : 0;
        lastHeight = height; lastCount = count;
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
    }
    return await page.evaluate(collectImagesInPage);
  } finally {
    await page.close().catch(() => {});
  }
}

// Fallback when no Chrome/Edge is installed: parse the raw HTML only.
async function scanStatic(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const base = res.url || url;
  const abs = (u) => { try { return new URL(u.replace(/&amp;/g, "&"), base).href; } catch { return null; } };
  const items = new Map();
  const re = /<img\b[^>]*?\b(?:data-src|src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = abs(m[1]);
    if (u && /^https?:/.test(u) && !items.has(u)) {
      const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(m[0]);
      items.set(u, { src: u, original: null, alt: alt ? alt[1] : "", w: 0, h: 0, kind: "img" });
    }
  }
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return { title: title ? title[1].trim() : "", items: [...items.values()] };
}

// ---------------------------------------------------------------- download

const EXT_BY_TYPE = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp", "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico", "image/tiff": "tif",
};

function extFrom(contentType, url) {
  const t = (contentType || "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_TYPE[t]) return EXT_BY_TYPE[t];
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(new URL(url).pathname);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "bin";
}

function sanitizeName(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 150) || "image";
}

async function fetchImage(url, referer) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Referer: referer || url, Accept: "image/*,*/*;q=0.8" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type");
  // SPA hosts often answer missing files with their HTML shell and status 200.
  if (/^text\/html/i.test(type || "")) throw new Error("이미지가 아닌 HTML 응답");
  return { buf: Buffer.from(await res.arrayBuffer()), type };
}

async function mapLimit(list, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

async function handleZip(req, res) {
  const body = JSON.parse(await readBody(req));
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return sendJson(res, 400, { error: "선택된 이미지가 없습니다." });
  const zipName = sanitizeName(body.zipName || "images").replace(/\.zip$/i, "") + ".zip";

  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="images.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    "X-File-Count": String(files.length),
  });
  // Images are already compressed; storing them is much faster and barely larger.
  const archive = archiver("zip", { store: true });
  archive.on("error", (e) => { console.error(e); res.destroy(e); });
  archive.pipe(res);

  const used = new Set();
  const uniqueName = (base, ext) => {
    let name = `${base}.${ext}`, n = 2;
    while (used.has(name.toLowerCase())) name = `${base} (${n++}).${ext}`;
    used.add(name.toLowerCase());
    return name;
  };

  // Append each image as soon as it arrives so the client sees bytes streaming in.
  const failed = [];
  await mapLimit(files, 6, async (f, i) => {
    try {
      const { buf, type } = await fetchImage(f.url, body.referer);
      const base = sanitizeName(String(f.name || `image_${i + 1}`).replace(/\.[a-z0-9]{2,5}$/i, ""));
      archive.append(buf, { name: uniqueName(base, extFrom(type, f.url)) });
    } catch (e) {
      failed.push(`${f.name}\t${f.url}\t${e.message}`);
    }
  });
  if (failed.length) archive.append("다운로드 실패 목록\n\n" + failed.join("\n") + "\n", { name: "_failed.txt" });
  await archive.finalize();
}

// ---------------------------------------------------------------- http

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function validUrl(u) {
  try { const url = new URL(u); return /^https?:$/.test(url.protocol) ? url : null; } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/scan") {
      const body = JSON.parse(await readBody(req));
      const target = validUrl(body.url);
      if (!target) return sendJson(res, 400, { error: "http(s) 주소를 입력해 주세요." });
      const opts = { scroll: body.scroll !== false, maxRounds: Math.min(Math.max(Number(body.maxRounds) || 40, 1), 200) };
      let result, mode;
      if (browserPath) {
        result = await scanWithBrowser(target.href, opts);
        mode = "browser";
      } else {
        result = await scanStatic(target.href);
        mode = "static";
      }
      return sendJson(res, 200, { ...result, mode, url: target.href });
    }

    // Thumbnail proxy for previews blocked by hotlink protection.
    if (req.method === "GET" && reqUrl.pathname === "/api/proxy") {
      const target = validUrl(reqUrl.searchParams.get("url"));
      if (!target) return sendJson(res, 400, { error: "bad url" });
      const { buf, type } = await fetchImage(target.href, reqUrl.searchParams.get("ref"));
      res.writeHead(200, { "Content-Type": type || "application/octet-stream", "Cache-Control": "max-age=3600" });
      return res.end(buf);
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/zip") return await handleZip(req, res);

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message || String(e) });
    else res.destroy(e);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Image ZIP Downloader: http://localhost:${PORT}`);
  console.log(browserPath ? `렌더링 브라우저: ${browserPath}` : "Chrome/Edge를 찾지 못해 정적 HTML 모드로 동작합니다.");
});

process.on("SIGINT", async () => {
  if (browserPromise) await (await browserPromise).close().catch(() => {});
  process.exit(0);
});
