// 既存の import はそのまま。S3Client などを使っている前提です。
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";

const API_BASE = process.env.REACT_APP_API_BASE || "http://127.0.0.1:8015";

export async function analyzeLogic(text) {
    return postJSON("/analyze-logic", { text });
  }

export async function postJSON(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getJSON(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const API = { BASE: API_BASE, postJSON, getJSON };


// ===== ユーザーIDの取得（単一の真実）=====
export function getCurrentUserId() {
  // お好みで差し替え可。例: ログイン時に localStorage.setItem('userId', '<UID>')
  return (
    window.__USER_ID__ ||
    localStorage.getItem("userId") ||
    sessionStorage.getItem("userId") ||
    "web-client" // 互換のための既定値
  );
}

// ===== S3 の設定（既存の値を使って OK）=====
const REGION = process.env.REACT_APP_AWS_REGION;     // 既存の環境変数を流用
const BUCKET = process.env.REACT_APP_S3_BUCKET;      // 既存の環境変数を流用
const S3_PREFIX_ROOT = (process.env.REACT_APP_S3_PREFIX || "app").replace(/\/+$/,""); // 例: "app"

const s3 = new S3Client({ region: REGION });

// Utils
async function streamToString(stream) {
  if (typeof stream.text === "function") return stream.text();
  return await new Response(stream).text();
}

// ====== 1) STT フル実行：user を FormData に同梱 ======
export async function postSttFull(fileBlob) {
  const form = new FormData();
  form.append("file", fileBlob);
  form.append("user", getCurrentUserId()); // ★ここだけ追加（バックエンド変更不要）

  const res = await fetch(`${API_BASE}/stt-full/`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`stt-full failed: ${res.status}`);
  return await res.json();
}

// ====== 2) ユーザー配下だけを S3 から読む ======

// 直近の実行（run）を列挙し、run ごとにまとめる。
// 返り値: [{ runId, base, lastModified, files: { result, transcript, audio_metrics } }]
export async function listRecentRunsFromS3({ maxKeys = 200 } = {}) {
  const user = getCurrentUserId();
  const prefix = `${S3_PREFIX_ROOT}/${user}/`; // 例: "app/masa-uid/"

  const cmd = new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: prefix,
    MaxKeys: maxKeys,
  });
  const out = await s3.send(cmd);
  const contents = out.Contents || [];

  // app/<user>/<YYYY>/<MM>/<DD>/<runId>/<file>
  const grouped = new Map();
  for (const obj of contents) {
    const key = obj.Key;
    const parts = key.split("/"); // [app, user, YYYY, MM, DD, runId, filename]
    if (parts.length < 7) continue;
    const runId = parts[5];
    const base = parts.slice(0, 6).join("/"); // app/user/YYYY/MM/DD/runId

    if (!grouped.has(base)) {
      grouped.set(base, {
        runId,
        base,
        lastModified: obj.LastModified,
        files: {},
      });
    }
    const g = grouped.get(base);
    const filename = parts[6];
    if (filename === "result.json") g.files.result = key;
    if (filename === "transcript.txt") g.files.transcript = key;
    if (filename === "audio_metrics.json") g.files.audio_metrics = key;

    // 最新日時を保持
    if (!g.lastModified || (obj.LastModified && obj.LastModified > g.lastModified)) {
      g.lastModified = obj.LastModified;
    }
  }

  // 新しい順に
  return Array.from(grouped.values()).sort(
    (a, b) => new Date(b.lastModified) - new Date(a.lastModified)
  );
}

// 任意のキーの中身をテキストで読む
export async function getObjectText(key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return await streamToString(out.Body);
}