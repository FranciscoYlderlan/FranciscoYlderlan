#!/usr/bin/env node
/**
 * Generates assets/stats.svg from live GitHub data — no third-party service.
 *
 *   node scripts/gh-stats.mjs            # fetches with GITHUB_TOKEN
 *   OFFLINE_DATA='{...}' node scripts/...  # renders from injected data
 *
 * Designed to run in GitHub Actions with the built-in GITHUB_TOKEN.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "assets/stats.svg");
const LOGIN = process.env.GH_LOGIN || "FranciscoYlderlan";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

const FALLBACK_COLORS = {
  TypeScript: "#3178C6", JavaScript: "#F1E05A", HTML: "#E34C26", CSS: "#563D7C",
  Rust: "#DEA584", "C#": "#178600", Java: "#B07219", Go: "#00ADD8",
  Python: "#3572A5", Shell: "#89E051", Dart: "#00B4AB", Kotlin: "#A97BFF",
};

const gql = async (query, variables) => {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`GraphQL ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
};

async function collect() {
  const data = await gql(
    `query($login:String!){
      user(login:$login){
        name createdAt
        followers{ totalCount }
        contributionsCollection{ totalCommitContributions restrictedContributionsCount }
        repositories(first:100, ownerAffiliations:OWNER, isFork:false, orderBy:{field:PUSHED_AT,direction:DESC}){
          totalCount
          nodes{
            stargazerCount
            languages(first:10, orderBy:{field:SIZE, direction:DESC}){
              edges{ size node{ name color } }
            }
          }
        }
      }
    }`,
    { login: LOGIN }
  );

  const u = data.user;
  const repos = u.repositories.nodes;
  const stars = repos.reduce((a, r) => a + r.stargazerCount, 0);

  const bytes = new Map();
  const colors = {};
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      bytes.set(node.name, (bytes.get(node.name) || 0) + size);
      if (node.color) colors[node.name] = node.color;
    }
  }
  const total = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...bytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, size]) => ({
      name,
      pct: +((size * 100) / total).toFixed(1),
      color: colors[name] || FALLBACK_COLORS[name] || "#6E7681",
    }));

  let commits =
    u.contributionsCollection.totalCommitContributions +
    u.contributionsCollection.restrictedContributionsCount;
  try {
    const r = await fetch(
      `https://api.github.com/search/commits?q=author:${LOGIN}&per_page=1`,
      { headers: { Authorization: `bearer ${TOKEN}`, Accept: "application/vnd.github+json" } }
    );
    if (r.ok) {
      const j = await r.json();
      if (typeof j.total_count === "number" && j.total_count > commits) commits = j.total_count;
    }
  } catch { /* keep contributions-based number */ }

  return {
    login: LOGIN,
    repos: u.repositories.totalCount,
    commits,
    stars,
    followers: u.followers.totalCount,
    since: new Date(u.createdAt).getUTCFullYear(),
    languages,
  };
}

/* ---------------------------------------------------------------- render */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nf = (n) => n.toLocaleString("en-US");

function countUp(value, x, y, size, fill) {
  const steps = 7;
  const frames = [];
  for (let i = 1; i <= steps; i++) {
    const v = i === steps ? value : Math.round((value / steps) * i * (0.72 + 0.04 * i));
    frames.push(Math.min(v, value));
  }
  const step = 0.11;
  return frames
    .map((v, i) => {
      const begin = (0.35 + i * step).toFixed(2);
      const anim =
        i === frames.length - 1
          ? `<animate attributeName="opacity" values="0;1" dur="0.18s" begin="${begin}s" fill="freeze"/>`
          : `<animate attributeName="opacity" values="1;1;0" keyTimes="0;0.6;1" dur="${step}s" begin="${begin}s" fill="freeze"/>`;
      return `<text class="m" x="${x}" y="${y}" font-size="${size}" fill="${fill}" opacity="${i === 0 ? 1 : 0}">${nf(v)}${
        i === 0 ? "" : ""
      }${anim}</text>`;
    })
    .join("");
}

function metric(x, y, value, label, color, animate, size = 30) {
  const num = animate
    ? countUp(value, x, y, size, color)
    : `<text class="m" x="${x}" y="${y}" font-size="${size}" fill="${color}" opacity="0"><animate attributeName="opacity" values="0;1" dur="0.5s" begin="0.6s" fill="freeze"/>${esc(value)}</text>`;
  return `${num}
    <text class="m" x="${x}" y="${y + 20}" font-size="11.5" fill="#6E7681" letter-spacing="1.4">${esc(label)}</text>`;
}

function render(d) {
  const barX = 530, barW = 440, barY = 150;
  let acc = 0;
  const segs = d.languages
    .map((l, i) => {
      const w = (l.pct / 100) * barW;
      const x = barX + acc;
      acc += w;
      return `<rect x="${x.toFixed(1)}" y="${barY}" width="0" height="14" fill="${l.color}">
        <animate attributeName="width" values="0;${w.toFixed(1)}" dur="0.7s" begin="${(0.5 + i * 0.12).toFixed(2)}s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.2 0.8 0.2 1"/>
      </rect>`;
    })
    .join("");

  const legend = d.languages
    .map((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = 530 + col * 226;
      const y = 200 + row * 26;
      return `<g opacity="0"><animate attributeName="opacity" values="0;1" dur="0.45s" begin="${(1.1 + i * 0.09).toFixed(2)}s" fill="freeze"/>
        <circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${l.color}"/>
        <text class="m" x="${x + 18}" y="${y}" font-size="12.5" fill="#C9D1D9">${esc(l.name)}</text>
        <text class="m" x="${x + 200}" y="${y}" font-size="12.5" fill="#6E7681" text-anchor="end">${l.pct}%</text>
      </g>`;
    })
    .join("");

  const synced = new Date().toISOString().slice(0, 10);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 300" width="1000" height="300" role="img" aria-label="GitHub statistics for ${esc(d.login)}">
  <defs>
    <linearGradient id="sp" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0D1117"/><stop offset="100%" stop-color="#0A0D13"/>
    </linearGradient>
    <filter id="sg" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <style>.m{font-family:"SFMono-Regular","JetBrains Mono",Consolas,"Liberation Mono",Menlo,monospace;}</style>

  <rect x="6" y="6" width="988" height="288" rx="14" fill="url(#sp)" stroke="#1F2937" stroke-width="1.5"/>
  <text class="m" x="30" y="42" font-size="12.5" fill="#6E7681" letter-spacing="2">$ gh api /users/${esc(d.login)} --stats</text>
  <text class="m" x="970" y="42" font-size="11" fill="#30363D" text-anchor="end">synced ${synced}</text>
  <line x1="30" y1="58" x2="970" y2="58" stroke="#1A2230"/>
  <line x1="490" y1="80" x2="490" y2="270" stroke="#1A2230"/>

  ${metric(30, 116, d.commits, "TOTAL COMMITS", "#00E5A0", true)}
  ${metric(270, 116, d.repos, "REPOSITORIES", "#38BDF8", true)}
  ${metric(30, 190, d.stars, "STARS EARNED", "#FFB86C", true)}
  ${metric(270, 190, d.followers, "FOLLOWERS", "#A78BFA", true)}
  ${metric(30, 258, `since ${d.since}`, "ON GITHUB", "#C9D1D9", false, 24)}
  ${metric(270, 258, `${d.languages.length}`, "LANGUAGES SHIPPED", "#C9D1D9", true, 24)}

  <text class="m" x="530" y="118" font-size="12" fill="#6E7681" letter-spacing="2">LANGUAGE DISTRIBUTION</text>
  <rect x="${barX}" y="${barY}" width="${barW}" height="14" rx="7" fill="#141B26"/>
  <g clip-path="url(#barClip)">${segs}</g>
  <clipPath id="barClip"><rect x="${barX}" y="${barY}" width="${barW}" height="14" rx="7"/></clipPath>
  ${legend}

  <rect x="530" y="${barY}" width="60" height="14" rx="7" fill="#FFFFFF" opacity="0.10" filter="url(#sg)">
    <animate attributeName="x" values="530;910;530" dur="6s" begin="2s" repeatCount="indefinite"/>
  </rect>
</svg>
`;
}

/* ------------------------------------------------------------------ main */

(async () => {
  let data;
  if (process.env.OFFLINE_DATA) {
    data = JSON.parse(process.env.OFFLINE_DATA);
  } else {
    if (!TOKEN) {
      console.error("No GITHUB_TOKEN available — skipping stats regeneration.");
      process.exit(0);
    }
    try {
      data = await collect();
    } catch (err) {
      console.error("Failed to collect stats, leaving existing SVG untouched:", err.message);
      process.exit(0);
    }
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, render(data), "utf8");
  console.log(`assets/stats.svg updated — ${nf(data.commits)} commits, ${data.repos} repos, ${data.languages.length} languages`);
})();
