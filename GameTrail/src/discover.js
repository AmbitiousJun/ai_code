const { load } = require("cheerio");
function references(body, type, base) {
  const urls = new Set();
  let origin = new URL(base).origin;
  function add(v) {
    if (typeof v !== "string" || !v.trim() || v.startsWith("#")) return;
    try {
      const u = new URL(v, base);
      if (u.origin === origin && /^https?:$/.test(u.protocol)) {
        u.hash = "";
        urls.add(u.href);
      }
    } catch {}
  }
  function css(s) {
    for (const m of s.matchAll(
      /url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)/gi,
    ))
      add(m[1] || m[2]);
  }
  if (/html/i.test(type)) {
    const $ = load(body);
    try {
      base = new URL($("base[href]").first().attr("href") || base, base).href;
    } catch {}
    $(
      'script[src],img[src],source[src],audio[src],video[src],link[rel~="stylesheet"],link[rel~="preload"],link[rel~="manifest"]',
    ).each((_, el) => add($(el).attr("src") || $(el).attr("href")));
    $("[srcset]").each((_, el) =>
      $(el)
        .attr("srcset")
        .split(",")
        .forEach((v) => add(v.trim().split(/\s/)[0])),
    );
    $("style,[style]").each((_, el) =>
      css($(el).attr("style") || $(el).text()),
    );
  } else if (/css/i.test(type)) css(body);
  else if (/json/i.test(type)) {
    try {
      const pending = [JSON.parse(body)];
      while (pending.length) {
        const v = pending.pop();
        if (
          typeof v === "string" &&
          /\.(json|png|webp|jpg|jpeg|avif|svg|css|js|wasm|ogg|mp3|woff2?|atlas|plist|bin)(?:[?#].*)?$/i.test(
            v,
          )
        )
          add(v);
        else if (v && typeof v === "object")
          for (const item of Object.values(v)) pending.push(item);
      }
    } catch {}
  }
  return [...urls];
}
module.exports = { references };
