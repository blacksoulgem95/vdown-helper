// HTML for the store canvases. Images come in as data: URIs (real captures of the extension), fonts are the ones the
// extension bundles. Colours are the extension's own (src/styles/theme.css).

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const base = (fonts) => `
${fonts}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden}
body{background:#080a12;color:#f2f5ff;font-family:'Inter Variable',system-ui,sans-serif;position:relative;-webkit-font-smoothing:antialiased}
.bg{position:absolute;inset:0;background:
  radial-gradient(900px 600px at -10% -10%,rgba(0,245,255,.13),transparent 60%),
  radial-gradient(800px 600px at 110% 110%,rgba(255,43,214,.13),transparent 60%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:40px 40px;-webkit-mask-image:radial-gradient(ellipse at 30% 40%,#000 20%,transparent 75%)}
.brand{display:flex;align-items:center;gap:12px}
.brand img{display:block}
.brand b{font-family:'JetBrains Mono',monospace;font-weight:700;letter-spacing:.02em}
.eyebrow{font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.22em;color:#00f5ff}
h1{font-weight:800;letter-spacing:-.035em;line-height:1.04}
h1 .hl{background:linear-gradient(90deg,#00f5ff,#ff2bd6);-webkit-background-clip:text;background-clip:text;color:transparent}
.muted{color:#aab3c5}
.window{position:absolute;border-radius:14px;overflow:hidden;background:#0d111c;border:1px solid rgba(255,255,255,.09);box-shadow:0 40px 90px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.4)}
.bar{height:44px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#141a29;border-bottom:1px solid rgba(255,255,255,.06)}
.dot{width:11px;height:11px;border-radius:50%;background:#2a3246}
.url{margin-left:14px;flex:1;height:26px;border-radius:13px;background:#0b0f19;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:12px;color:#7f8aa3}
.url i{width:9px;height:9px;border:1.5px solid #7f8aa3;border-radius:2px;display:inline-block}
.ext{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:rgba(0,245,255,.12);box-shadow:0 0 0 1.5px rgba(0,245,255,.6),0 0 18px rgba(0,245,255,.35)}
.shot{display:block;width:100%}
.popup{position:absolute;border-radius:12px;overflow:hidden;box-shadow:0 30px 70px rgba(0,0,0,.6),0 0 0 1px rgba(0,245,255,.45),0 0 40px rgba(0,245,255,.18)}
.popup img{display:block;width:100%}
`;

const browserBar = (logo, address) =>
  `<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
   <div class="url"><i></i>${esc(address)}</div><div class="ext"><img src="${logo}" width="20" height="20" alt=""></div></div>`;

const title = (lines) => `${esc(lines[0])}<br><span class="hl">${esc(lines[1])}</span>`;

/** 1280 x 800: the claim on the left, the real UI on the right (popup over the page, or the Studio as a side panel). */
export function screenshotHtml({ fonts, logo, copy, page, panel, kind, address }) {
  const winLeft = 520;
  const winWidth = 720;
  const check = `<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="rgba(183,255,60,.12)" stroke="#b7ff3c" stroke-width="1.4"/><path d="M6 10.2l2.6 2.6L14 7.4" fill="none" stroke="#b7ff3c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const left = `
  <div style="position:absolute;left:64px;top:0;width:420px;height:800px;display:flex;flex-direction:column;justify-content:center">
    <div class="brand"><img src="${logo}" width="38" height="38" alt=""><b style="font-size:16px">vdown-helper</b></div>
    <p class="eyebrow" style="font-size:13px;margin-top:44px">${esc(copy.eyebrow)}</p>
    <h1 style="font-size:50px;margin-top:14px">${title(copy.title)}</h1>
    <p class="muted" style="font-size:18px;line-height:1.55;margin-top:22px">${esc(copy.body)}</p>
    <ul style="list-style:none;margin-top:30px;display:grid;gap:14px">
      ${copy.points.map((p) => `<li style="display:flex;align-items:center;gap:12px;font-size:16px;font-weight:500">${check}${esc(p)}</li>`).join('')}
    </ul>
  </div>`;
  if (kind === 'sidepanel') {
    const top = 64;
    const height = 800 - 2 * top;
    return `<!doctype html><html><head><meta charset="utf-8"><style>${base(fonts)}</style></head><body><div class="bg"></div><div class="grid"></div>${left}
    <div class="window" style="left:${winLeft}px;top:${top}px;width:${winWidth}px;height:${height}px">
      ${browserBar(logo, address)}
      <div style="display:flex;height:${height - 44}px">
        <div style="flex:1;overflow:hidden;background:#fff"><img class="shot" src="${page}" style="width:${height * 1.6 - 70}px;max-width:none" alt=""></div>
        <div style="width:330px;overflow:hidden;border-left:1px solid rgba(0,245,255,.35);box-shadow:-20px 0 40px rgba(0,0,0,.35)"><img class="shot" src="${panel}" alt=""></div>
      </div>
    </div></body></html>`;
  }
  const pageHeight = Math.round((winWidth * 800) / 1280);
  const winTop = Math.round((800 - (pageHeight + 44)) / 2) - 40;
  const popupWidth = 378;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${base(fonts)}</style></head><body><div class="bg"></div><div class="grid"></div>${left}
  <div class="window" style="left:${winLeft}px;top:${winTop}px;width:${winWidth}px;height:${pageHeight + 44}px">
    ${browserBar(logo, address)}<img class="shot" src="${page}" alt="">
  </div>
  <div class="popup" style="left:${winLeft + winWidth - popupWidth - 10}px;top:${winTop + 50}px;width:${popupWidth}px"><img src="${panel}" alt=""></div>
  </body></html>`;
}

/** 440 x 280: logo, two lines, the popup peeking in from the right. */
export function promoHtml({ fonts, logo, copy, popup }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${base(fonts)}</style></head><body><div class="bg"></div><div class="grid"></div>
  <div style="position:absolute;left:26px;top:0;height:280px;width:250px;display:flex;flex-direction:column;justify-content:center">
    <div class="brand"><img src="${logo}" width="34" height="34" alt=""><b style="font-size:14px">vdown-helper</b></div>
    <h1 style="font-size:31px;margin-top:20px">${title(copy.title)}</h1>
    <p class="eyebrow" style="font-size:9.5px;margin-top:16px;letter-spacing:.18em">${esc(copy.tagline)}</p>
  </div>
  <div class="popup" style="left:272px;top:30px;width:200px;transform:rotate(-3deg)"><img src="${popup}" alt=""></div>
  </body></html>`;
}

/** 1400 x 560: the promise on the left, the page with the popup on the right. */
export function marqueeHtml({ fonts, logo, copy, page, popup, address }) {
  const winLeft = 730;
  const winWidth = 630;
  const pageHeight = Math.round((winWidth * 800) / 1280);
  const winTop = Math.round((560 - (pageHeight + 44)) / 2);
  const popupWidth = 300;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${base(fonts)}</style></head><body><div class="bg"></div><div class="grid"></div>
  <div style="position:absolute;left:76px;top:0;width:620px;height:560px;display:flex;flex-direction:column;justify-content:center">
    <div class="brand"><img src="${logo}" width="40" height="40" alt=""><b style="font-size:17px">vdown-helper</b></div>
    <h1 style="font-size:50px;margin-top:30px;white-space:nowrap">${title(copy.title)}</h1>
    <p class="muted" style="font-size:19px;line-height:1.5;margin-top:20px;max-width:520px">${esc(copy.body)}</p>
    <div style="display:flex;gap:10px;margin-top:28px">
      ${copy.chips.map((c) => `<span style="font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding:7px 12px;border-radius:999px;border:1px solid rgba(0,245,255,.4);color:#00f5ff;background:rgba(0,245,255,.06)">${esc(c)}</span>`).join('')}
    </div>
  </div>
  <div class="window" style="left:${winLeft}px;top:${winTop}px;width:${winWidth}px;height:${pageHeight + 44}px">
    ${browserBar(logo, address)}<img class="shot" src="${page}" alt="">
  </div>
  <div class="popup" style="left:${winLeft + winWidth - popupWidth - 10}px;top:${winTop + 50}px;width:${popupWidth}px;max-height:${560 - winTop - 50 - 16}px"><img src="${popup}" alt=""></div>
  </body></html>`;
}

/** The site's hero art (no words: the page around it carries them): the demo page with the popup open, on the site's background. */
export function heroHtml({ fonts, logo, page, popup, address }) {
  const winWidth = 820;
  const pageHeight = Math.round((winWidth * 800) / 1280);
  const popupWidth = 460;
  // Transparent around the art: the site's own background shows through (site images have no store rules).
  return `<!doctype html><html><head><meta charset="utf-8"><style>${base(fonts)}
  body{background:transparent}
  </style></head><body>
  <div class="window" style="left:30px;top:150px;width:${winWidth}px;height:${pageHeight + 44}px">
    ${browserBar(logo, address)}<img class="shot" src="${page}" alt="">
  </div>
  <div class="popup" style="left:${30 + winWidth - popupWidth + 220}px;top:40px;width:${popupWidth}px"><img src="${popup}" alt=""></div>
  </body></html>`;
}
