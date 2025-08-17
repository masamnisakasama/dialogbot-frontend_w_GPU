import React, { useState, useRef, useEffect } from "react";
// 表示切替（あとで見たくなったら true に）
const SHOW_OUTLINE = false;
const SHOW_ADVICE  = false;

// 追加：論理構造アドバイスのしきい値（必要に応じて調整してください）
const LOGIC_ADVICE_THRESH = {
  clarity: 75,
  consistency: 75,
  cohesion: 75,
  density: 60,
  cta: 60,
};

const API_BASE = process.env.REACT_APP_API_BASE || "http://127.0.0.1:8015";

// 現在のユーザーIDを取得（window.__USER_ID__ → localStorage → sessionStorage → 既定 "web-client"）
function getCurrentUserId() {
  return (
    (typeof window !== "undefined" && window.__USER_ID__) ||
    (typeof window !== "undefined" && window.localStorage && window.localStorage.getItem("userId")) ||
    (typeof window !== "undefined" && window.sessionStorage && window.sessionStorage.getItem("userId")) ||
    "web-client"
  );
}

const STT_PROMPT =
  "ネビュラシステムズ,NovaDesk Assist,ヘルプデスク,一次回答,エスカレーション,バックログ," +
  "MTTA,MTTR,Confluence,SharePoint,Teams,Slack,Jira,ServiceNow,Azure AD,Okta,SAML,OIDC,SCIM";

async function fetchWithLongTimeout(url, options = {}, ms = 10 * 60 * 1000, abortRef) {
  const ctrl = new AbortController();
  if (abortRef) abortRef.current = ctrl;
  const id = setTimeout(() => ctrl.abort(new Error("timeout")), ms);

  try {
    // ★ 追記：ユーザー別保存のためのヘッダ（任意のIDに変更可）
    const headers = new Headers(options.headers || {});
    if (!headers.has("X-User-Id")) headers.set("X-User-Id", getCurrentUserId());

    const res = await fetch(url, { ...options, headers, signal: ctrl.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${txt || res.statusText}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("タイムアウトしました");
    throw e;
  } finally {
    clearTimeout(id);
    if (abortRef) abortRef.current = null;
  }
}

export default function App() {
  return (
    <div className="page">
      <Style />
      <header className="header">
        <div className="brand">
          <span className="logo">🎧</span>
          <h1>DialogBot</h1>
        </div>
        <p className="subtitle">音声をテキスト化して、プロファイルおよびアドバイスを行います。</p>
      </header>

      <main className="main">
        <Card>
          <SpeechToText />
        </Card>

        <div style={{ height: 12 }} />

        <Card>
          <ProfilePanel userId={getCurrentUserId()} days={7} />
        </Card>

        <div style={{ height: 12 }} />

        {/* ★ 追記：S3の最近の結果一覧（署名URLで開ける） */}
        <Card>
          <RecentResults userId={getCurrentUserId()} days={7} limit={30} />
        </Card>
      </main>
    </div>
  );
}

/* ============== 録音/ファイル → STT → ingest ============== */

function SpeechToText() {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const abortRef = useRef(null);

  const pickMimeType = () => {
    if (window.MediaRecorder?.isTypeSupported?.("audio/webm")) return "audio/webm";
    if (window.MediaRecorder?.isTypeSupported?.("audio/ogg")) return "audio/ogg";
    if (window.MediaRecorder?.isTypeSupported?.("audio/mp4")) return "audio/mp4";
    return "";
  };

  const start = async () => {
    setError(""); setResult(null); chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => { await uploadOnce(stream); };

      mediaRecorderRef.current = mr;
      mr.start(200);
      setRecording(true);
    } catch (e) {
      setError(`マイク取得に失敗しました: ${e?.message || e}`);
    }
  };

  const stop = () => {
    if (!mediaRecorderRef.current) return;
    if (mediaRecorderRef.current.state !== "inactive") {
      try { mediaRecorderRef.current.requestData?.(); } catch {}
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  };

  const sendForm = async (formData) => {
    const tryOnce = async (url, ms = 10 * 60 * 1000) => {
      const json = await fetchWithLongTimeout(url, { method: "POST", body: formData }, ms, abortRef);
      const transcript = json.text ?? json.transcript ?? json.result?.text ?? "";
      setResult({ ...json, transcript });
      return transcript;
    };

    try {
      // まずは通常の STT（長めに待つ）
      return await tryOnce(`${API_BASE}/stt-full/?detail=true`);
    } catch (e) {
      // フォールバック：/analyze/audio も長めに待つ
      return await tryOnce(`${API_BASE}/analyze/audio?detail=true`);
    }
  };

  const ingestProfile = async (text) => {
    if (!text) return;
    try {
      await fetch(`${API_BASE}/profile/ingest?user_id=${encodeURIComponent(getCurrentUserId())}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": getCurrentUserId() }, // ← 念のため明示
        body: JSON.stringify({ text }),
      });
      window.dispatchEvent(new Event("profile-updated"));
    } catch {}
  };

  const uploadOnce = async (stream) => {
    if (processing) return;
    setProcessing(true); setError("");

    try {
      const mime = chunksRef.current[0]?.type || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mime });

      if (!blob || blob.size < 1024) {
        setError("音声データが空でした。2秒以上話してから停止してください。");
        return;
      }

      const filename =
        "voice." + (mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "mp4" : "webm");

      const fd = new FormData();
      fd.append("file", blob, filename);
      fd.append("user", getCurrentUserId());

      const text = await sendForm(fd);
      await ingestProfile(text);
    } catch (e) {
      if (e.name !== "AbortError") setError(`送信に失敗: ${e?.message || e}`);
    } finally {
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      setProcessing(false);
    }
  };

  // 追加：音声ファイルを直接アップロード
  const onPickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size < 1024) { setError("ファイルサイズが小さすぎます（1KB未満）。"); return; }
    setProcessing(true); setError(""); setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("user", getCurrentUserId());
      const text = await sendForm(fd);
      await ingestProfile(text);
    } catch (err) {
      if (err.name !== "AbortError") setError(`送信に失敗: ${err?.message || err}`);
    } finally {
      setProcessing(false);
    }
  };

  const cancel = () => { if (abortRef.current) abortRef.current.abort(); setProcessing(false); };

  const stateLabel = recording ? "録音中…" : processing ? "送信中…" : "待機中";

  return (
    <>
      <h3 style={{marginTop:0}}>マイク/ファイルから解析</h3>
      <div className="controls">
        <button className="btn primary" onClick={start} disabled={recording || processing}>
          <span className="btn-emoji">●</span> 録音開始
        </button>
        <button className="btn" onClick={stop} disabled={!recording}>
          ⏹ 停止（送信）
        </button>

        <label className="btn" style={{ cursor: "pointer" }}>
          📁 音声ファイルを選択
          <input
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"
            onChange={onPickFile}
            style={{ display: "none" }}
          />
        </label>

        <button className="btn ghost" onClick={cancel} disabled={!processing}>
          🛑 送信中断
        </button>
        <span className={`state ${recording ? "rec" : processing ? "proc" : ""}`}>{stateLabel}</span>
      </div>

      {error && <Alert type="error" text={error} />}

      <ResultPanels result={result} />
    </>
  );
}

/* ============== 結果表示（音声メトリクス + 論理構造） ============== */

// 追加：論理構造アドバイス生成（敬語）
function buildLogicAdvice(logic) {
  const t = LOGIC_ADVICE_THRESH;
  const s = logic?.scores || {};
  const adv = [];

  if (Number.isFinite(s.clarity) && s.clarity < t.clarity) {
    adv.push(`「構成の明瞭さ」が基準値を下回っております（${Math.round(s.clarity)} / ${t.clarity}）。結論→理由→具体例→要約の順でお話しいただくと、より分かりやすくなります。文頭で要点を先にお示しください。`);
  }
  if (Number.isFinite(s.consistency) && s.consistency < t.consistency) {
    adv.push(`「論理的一貫性」が基準値を下回っております（${Math.round(s.consistency)} / ${t.consistency}）。用語や指標の表記を統一し、主張と根拠の対応関係をご確認ください。矛盾する表現は整理いただけると整います。`);
  }
  if (Number.isFinite(s.cohesion) && s.cohesion < t.cohesion) {
    adv.push(`「まとまり／結束性」が基準値を下回っております（${Math.round(s.cohesion)} / ${t.cohesion}）。段落のつなぎに「まず／次に／つまり／一方で／結果として」等の接続語を加え、指示語は具体語に置き換えていただくと流れが滑らかになります。`);
  }
  if (Number.isFinite(s.density) && s.density < t.density) {
    adv.push(`「要点密度」が基準値を下回っております（${Math.round(s.density)} / ${t.density}）。冗長な修飾を削り、数値・固有名詞・期限など情報量の高い語を前半に配置いただくと、密度が向上いたします。`);
  }
  if (Number.isFinite(s.cta) && s.cta < t.cta) {
    adv.push(`「CTAの明確さ」が基準値を下回っております（${Math.round(s.cta)} / ${t.cta}）。最後に「次に何をしてほしいか」を一文で明示ください（例：◯日までにご返信／デモのご予約はこちら／資料のダウンロードはこちら 等）。`);
  }
  return adv;
}

function ResultPanels({ result }) {
  const [logic, setLogic] = React.useState(null);
  const [logicLoading, setLogicLoading] = React.useState(false);
  const [logicErr, setLogicErr] = React.useState("");

  // transcript が来たら論理構造を取得
  React.useEffect(() => {
    let cancelled = false;
    async function run() {
      const text = result?.transcript || result?.text || "";
      if (!text) { setLogic(null); return; }
      setLogicLoading(true); setLogicErr("");
      try {
        const res = await fetch(`${API_BASE}/analyze-logic`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-User-Id": getCurrentUserId() },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setLogic(data);
      } catch (e) {
        if (!cancelled) setLogicErr(e?.message || String(e));
      } finally {
        if (!cancelled) setLogicLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [result?.transcript, result?.text]);

  if (!result) return null;

  return (
    <>
      {result?.transcript && (
        <Section title="テキスト">
          <div className="transcript">{result.transcript}</div>
          <div className="transcript-actions">
            <button className="btn" onClick={() => navigator.clipboard.writeText(result.transcript)}>📋 コピー</button>
          </div>
        </Section>
      )}

      {/* 論理構造（構成/論理性スコア） */}
      <Section title="論理構造">
        {!logic && !logicLoading && !logicErr && <div className="muted">音声を解析すると表示されます。</div>}
        {logicLoading && <div className="muted">解析中…</div>}
        {logicErr && <Alert type="warn" text={`論理構造の取得に失敗しました：${logicErr}`} />}
        {logic && (
          <div className="logic">
            <div className="logic-total">
              <div className="logic-total-num">{(logic.total ?? 0).toFixed(1)}</div>
              <div className="logic-total-sub">総合(0–100)</div>
            </div>
            <div className="logic-bars">
              {[
                ["構成の明瞭さ", "clarity"],
                ["論理的一貫性", "consistency"],
                ["まとまり/結束性", "cohesion"],
                ["要点密度", "density"],
                ["CTAの明確さ", "cta"],
              ].map(([label, key]) => (
                <div className="bar" key={key}>
                  <span className="lb">{label}</span>
                  <progress max="100" value={logic?.scores?.[key] || 0}></progress>
                  <span className="val">{Math.round(logic?.scores?.[key] ?? 0)}</span>
                </div>
              ))}
            </div>
            {SHOW_OUTLINE && Array.isArray(logic.outline) && logic.outline.length > 0 && (
              <>
                <div className="subhead">検出アウトライン</div>
                <ul className="list">{logic.outline.map((x,i)=><li key={i}>{x}</li>)}</ul>
              </>
            )}
            {SHOW_ADVICE && Array.isArray(logic.advice) && logic.advice.length > 0 && (
              <>
                <div className="subhead">改善ヒント</div>
                <ul className="list">{logic.advice.map((x,i)=><li key={i}>{x}</li>)}</ul>
              </>
            )}
          </div>
        )}
      </Section>

      <div className="grid">
        <Section title="メタ情報">
          <KV label="言語" value={result.language || "-"} />
          <KV label="音声長" value={(result.duration_sec ?? 0).toFixed(2) + " sec"} />
          <KV label="使用モデル" value={result.model || "-"} />
        </Section>

        {/* 追加：論理構造しきい値アドバイス（メタ情報の直下に表示） */}
        {logic && (() => {
          const adv = buildLogicAdvice(logic);
          return adv.length > 0 ? (
            <Section title="改善アドバイス（スコア基準）">
              <ul className="list">
                {adv.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </Section>
          ) : null;
        })()}

        {result.audio_metrics && (
          <Section title="音声品質・分析">
            <AudioQualityPanel
              metrics={result.audio_metrics}
              lang={result.language}
              durationSec={result.duration_sec}
            />
            <details className="raw-toggle">
              <summary>Raw</summary>
              <pre className="mono" style={{ marginTop: 8 }}>
                {JSON.stringify(result.audio_metrics, null, 2)}
              </pre>
            </details>
          </Section>
        )}
      </div>
    </>
  );
}

/* compact アドバイス付きの表示（縦長解消版） */
function AudioQualityPanel({ metrics = {}, lang = "ja", durationSec = 0 }) {
  const n = (x, d = 0) => (typeof x === "number" && isFinite(x) ? x : d);
  const m = {
    wpm: n(metrics.speech_rate_wpm),
    cps: n(metrics.speech_rate_cps),
    pauseRatio: n(metrics.pause_ratio),
    pauses: n(metrics.num_pauses),
    avgPause: n(metrics.avg_pause_sec),
    medPause: n(metrics.median_pause_sec),
    voiced: n(metrics.voiced_time_sec),
    density: n(metrics.utterance_density),
    segLen: n(metrics.avg_segment_sec),
    segNum: n(metrics.num_segments),
  };
  const isJa = String(lang || "").toLowerCase().startsWith("ja");

  const R = {
    cps: isJa ? [3.0, 5.0] : [2.0, 4.0],
    wpm: isJa ? [0, 9999] : [120, 170],
    pauseRatio: [0.01, 0.15],
    avgPause: [0.20, 0.60],
    density: [0.85, 0.99],
    segLen: [2.8, 5],
  };
  const band = (v, [lo, hi]) => (isNaN(v) ? "na" : v < lo ? "low" : v > hi ? "high" : "ok");
  const status = {
    cps: band(m.cps, R.cps),
    wpm: band(m.wpm, R.wpm),
    pauseRatio: band(m.pauseRatio, R.pauseRatio),
    avgPause: band(m.avgPause, R.avgPause),
    density: band(m.density, R.density),
    segLen: band(m.segLen, R.segLen),
  };

  const advice = [];
  if (status.cps === "high") advice.push("話速がやや速めでいらっしゃいます。キーワードの前後に 0.2〜0.4 秒の間を意識していただくと、より聞き取りやすくなります。");
  if (status.cps === "low")  advice.push("話速がややゆっくりでいらっしゃいます。文末の無音を少し短くし、接続詞でテンポを作っていただくと自然に感じられます。");
  // ポーズ・密度系Sは非表示運用のためメッセーSジも抑制
  if (status.segLen === "high") advice.push("1 セグメントがやや長い傾向でございます。3〜5 秒程度でお区切りいただくと、さらに明瞭になります。");
  if (status.segLen === "low") advice.push("1 セグメントが短い傾向でございます。文章の区切りごとの長さをもう少し長くしていただけると、より自然に聞こえます。");

  const Gauge = ({ value, range, label, unit = "", aux }) => {
    const [lo, hi] = range;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const pct = isFinite(value) ? clamp(((value - lo) / (hi - lo)) * 100, 0, 100) : 0;
    return (
      <div className="aq-item">
        <div className="aq-title">
          <span>{label}</span>
          <span className="badge">{isFinite(value) ? `${value.toFixed(2)}${unit}` : "—"}</span>
        </div>
        <div className="aq-rail"><div className="aq-fill" style={{ width: `${pct}%` }} /></div>
        {aux && <div className="aq-aux">{aux}</div>}
      </div>
    );
  };

  const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : "—");
  const miniItems = [
    ["WPM（語/分）", m.wpm],
    ["CPS（文字/秒）", m.cps],
    //["ポーズ比率", m.pauseRatio],
    //["ポーズ回数", m.pauses],
    //["平均ポーズ(s)", m.avgPause],
    //["中央値ポーズ(s)", m.medPause],
    ["有声時間(s)", m.voiced],
    //["発話密度", m.density],
    ["平均セグメント(s)", m.segLen],
    ["セグメント数", m.segNum],
  ];

  return (
    <>
      <div className="aq-grid">
        <div className="aq-col">
          <div className="aq-title head">
            <span>話速</span>
            <span className="pill">{isJa ? `CPS: ${m.cps.toFixed(2)}` : `WPM: ${m.wpm ? m.wpm.toFixed(0) : "—"}`}</span>
          </div>
          <div className="aq-sub">{isJa ? "目安 3.0–5.0 文字/秒" : "目安 120–170 語/分"}</div>
          <Gauge value={m.cps} range={R.cps} label="CPS（文字/秒）" />
          {!isJa && <Gauge value={m.wpm} range={R.wpm} label="WPM（語/分）" />}
        </div>

        {/*
        <div className="aq-col">
          <Gauge
            value={m.pauseRatio}
            range={R.pauseRatio}
            label="ポーズ比率"
            aux={`ポーズ ${m.pauses} 回 / 平均 ${m.avgPause.toFixed(2)}s（1–15% 目安）`}
          />
          <Gauge value={m.density} range={R.density} label="発話密度" aux="0.85–0.99 目安" />
        </div>
        */}
        <div className="aq-col">
          <Gauge
            value={m.segLen}
            range={R.segLen}
            label="平均セグメント長"
            unit="s"
            aux={`セグメント ${m.segNum} 個 / 平均 ${m.segLen.toFixed(2)}s（目安 2.8–5.0s）`}
          />
          <div className="aq-item">
            <div className="aq-title">
              <span>有声時間</span>
              <span className="badge">{`${m.voiced.toFixed(1)}s`}</span>
            </div>
            <div className="aq-aux">（参考）全体 {durationSec ? `${durationSec.toFixed(1)}s` : "—"}</div>
          </div>
        </div>
      </div>

      <div className="mini-kv-grid">
        {miniItems.map(([k, v]) => (
          <div className="mini-kv" key={k}>
            <span className="k">{k}</span>
            <span className="v">{fmt(v)}</span>
          </div>
        ))}
      </div>

      {advice.length > 0 && (
        <div className="aq-advice">
          <div className="aq-advice-title">アドバイス</div>
          <ul>
            {advice.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

/* ============== プロファイル（Style/Mood/Interest） ============== */

function ProfilePanel({ userId = "web-client", days = 7 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const STYLE_KEYS = [
    { key: "polite", label: "丁寧" }, { key: "friendly", label: "フレンドリー" },
    { key: "assertive", label: "主張的" }, { key: "empathetic", label: "共感的" },
    { key: "formal", label: "フォーマル" }, { key: "casual", label: "カジュアル" },
    { key: "abstract", label: "抽象" }, { key: "concrete", label: "具体" },
    { key: "concise", label: "簡潔" }, { key: "verbose", label: "冗長" },
    { key: "expert", label: "専門" }, { key: "explanatory", label: "解説的" },
    { key: "humorous", label: "ユーモア" }, { key: "persuasive", label: "説得的" },
  ];
  const MOOD_KEYS = [
    { key: "pos", label: "ポジティブ" }, { key: "neg", label: "ネガティブ" },
    { key: "arousal", label: "起伏" }, { key: "calm", label: "落ち着き" },
    { key: "excited", label: "興奮" }, { key: "confident", label: "自信" },
    { key: "anxious", label: "不安" }, { key: "frustrated", label: "苛立ち" },
    { key: "satisfied", label: "満足" }, { key: "curious", label: "好奇心" },
  ];
  const INTEREST_KEYS = [
    { key: "tech", label: "技術" }, { key: "science", label: "科学" },
    { key: "art", label: "芸術" }, { key: "design", label: "デザイン" },
    { key: "philo", label: "哲学" }, { key: "business", label: "ビジネス" },
    { key: "finance", label: "ファイナンス" }, { key: "history", label: "歴史" },
    { key: "literature", label: "文学" }, { key: "education", label: "教育" },
    { key: "health", label: "健康" }, { key: "sports", label: "スポーツ" },
    { key: "entertain", label: "エンタメ" }, { key: "travel", label: "旅行" },
    { key: "food", label: "食" }, { key: "gaming", label: "ゲーム" },
  ];

  const fetchProfile = async () => {
    setLoading(true); setErr("");
    try {
      const url = `${API_BASE}/profile/snapshot?user_id=${encodeURIComponent(userId)}&days=${days}`;
      const res = await fetch(url, { headers: { Accept: "application/json", "X-User-Id": userId } });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt || res.statusText}`);
      const json = JSON.parse(txt);
      setData(json);
    } catch (e) {
      setErr(e.message || String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProfile(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [userId, days]);
  useEffect(() => {
    const h = () => fetchProfile();
    window.addEventListener("profile-updated", h);
    return () => window.removeEventListener("profile-updated", h);
  }, []);

  return (
    <>
      <div className="section-header">
        <h3>あなたの傾向（直近{days}日）</h3>
        <div className="spacer" />
        <button className="btn" onClick={fetchProfile} disabled={loading}>
          {loading ? "更新中…" : "最新を取得"}
        </button>
      </div>

      {err && <Alert type="error" text={err} />}

      {!data ? (
        <div className="mono">データを取得しています。</div>
      ) : (
        <>
          <div className="grid">
            <MiniCard title="Style"><BarsGroup dict={data.style || {}} keys={STYLE_KEYS} /></MiniCard>
            <MiniCard title="Mood"><BarsGroup dict={data.mood || {}} keys={MOOD_KEYS} /></MiniCard>
            <MiniCard title="Interest"><BarsGroup dict={data.interest || {}} keys={INTEREST_KEYS} /></MiniCard>
          </div>
          <div className="updated-at">更新: {safeDate(data.updated_at)} / サンプル: {data.count ?? 0}</div>
        </>
      )}
    </>
  );
}

/* ============== S3 最近の結果（新規追加・両表記に対応） ============== */

function RecentResults({ userId = "web-client", days = 7, limit = 30 }) {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState("");

  // files の表記ゆれを吸収して UI 用に正規化
  const normalize = (data) =>
    (data.items || [])
      .map((it) => {
        const f = it.files || {};
        const transcript = f.transcript || f.txt;
        const result = f.result || f["result.json"];
        const metrics = f.metrics || f["metrics.json"];
        const raw = f.rawreq || f.raw;

        return {
          updated_at: it.updated_at,
          files: {
            txt: transcript && (transcript.url ? { url: transcript.url } : transcript.key ? { key: transcript.key } : null),
            "result.json": result && (result.url ? { url: result.url } : result.key ? { key: result.key } : null),
            "metrics.json": metrics && (metrics.url ? { url: metrics.url } : metrics.key ? { key: metrics.key } : null),
            rawreq: raw && (raw.url ? { url: raw.url } : raw.key ? { key: raw.key } : null),
          },
        };
      })
      // URL/KEY いずれも無い行を除外（空の行対策）
      .filter((it) => {
        const f = it.files || {};
        const hasAny =
          (f.txt && (f.txt.url || f.txt.key)) ||
          (f["result.json"] && (f["result.json"].url || f["result.json"].key)) ||
          (f["metrics.json"] && (f["metrics.json"].url || f["metrics.json"].key)) ||
          (f.rawreq && (f.rawreq.url || f.rawreq.key));
        return !!hasAny;
      });

  const load = async () => {
    setLoading(true); setErr("");
    try {
      const url = `${API_BASE}/results/list?user_id=${encodeURIComponent(userId)}&days=${days}&limit=${limit}`;
      const res = await fetch(url, { headers: { "X-User-Id": userId } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(normalize(data));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => { load(); }, [userId, days, limit]);

  return (
    <Section title="クラウド上のストレージ（S3）から最近の結果を取得します">
      <div className="section-header" style={{marginBottom:8}}>
        <div className="spacer" />
        <button className="btn" onClick={load} disabled={loading}>{loading ? "更新中…" : "再読み込み"}</button>
      </div>
      {err && <Alert type="error" text={err} />}
      {(!items || items.length === 0) ? (
        <div className="mono">まだ結果がありません。</div>
      ) : (
        <div className="list" style={{paddingLeft:0}}>
          {items.map((it, idx) => {
            const f = it.files || {};
            const t = f.txt;
            const r = f["result.json"];
            const m = f["metrics.json"];
            const raw = f.rawreq;
            const hasTxt = !!t && !!t.url;
            const hasJson = !!r && !!r.url;
            const hasMet = !!m && !!m.url;
            return (
              <div key={idx} className="minicard" style={{marginBottom:8}}>
                <div className="minicard-head">
                  {new Date(it.updated_at).toLocaleString()}
                </div>
                <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
                  {hasTxt && <a className="btn" href={t.url} target="_blank" rel="noreferrer">📝 テキスト</a>}
                  {hasJson && <a className="btn" href={r.url} target="_blank" rel="noreferrer">📦 結果JSON</a>}
                  {hasMet && <a className="btn" href={m.url} target="_blank" rel="noreferrer">📈 メトリクスJSON</a>}
                  {raw && raw.url && <a className="btn ghost" href={raw.url} target="_blank" rel="noreferrer">🗂 原文(raw)</a>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function BarsGroup({ dict, keys }) {
  const missing = (k) => dict[k] == null || Number.isNaN(Number(dict[k]));
  const pct = (v) => `${Math.round(Number(v) * 100)}%`;
  return (
    <>
      {keys.map(({ key, label }) => {
        const isMissing = missing(key);
        const v = Number(dict?.[key] ?? 0);
        return (
          <div key={key} className={`metricbar ${isMissing ? "missing" : ""}`}>
            <div className="metricbar-row">
              <span title={key}>{label}</span>
              <span className="metricbar-num">{isMissing ? "—" : pct(v)}</span>
            </div>
            <div className="metricbar-rail">
              <div className="metricbar-fill" style={{ width: isMissing ? "0%" : pct(v) }} />
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ============== UI Parts / Utils / Style ============== */

function Card({ children }) { return <div className="card">{children}</div>; }
function MiniCard({ title, children }) { return (<div className="minicard"><div className="minicard-head">{title}</div><div>{children}</div></div>); }
function Section({ title, children }) { return (<section className="section"><h3>{title}</h3>{children}</section>); }
function KV({ label, value }) { return (<div className="kv"><span className="kv-label">{label}</span><span className="kv-value">{value}</span></div>); }
function Alert({ type = "info", text }) { return <div className={`alert ${type}`}>{text}</div>; }
function safeDate(iso) { try { return new Date(iso).toLocaleString(); } catch { return "-"; } }

function Style() {
  return (
    <style>{`
:root{
  --bg:#0b0c10; --panel:#111218; --panel-2:#0f1016; --text:#dfe3ea; --muted:#9aa3b2;
  --primary:#6ae3ff; --primary-2:#3cc6e6; --danger:#ff6b7d; --border:#1b1d27;
  --code:#0b0d13; --shadow:0 10px 30px rgba(0,0,0,.25);
}
@media (prefers-color-scheme: light){
  :root{
    --bg:#f6f7fb; --panel:#ffffff; --panel-2:#f1f3f8; --text:#111318; --muted:#5a6472;
    --primary:#0ea5e9; --primary-2:#0284c7; --danger:#e11d48; --border:#e6e8ef;
    --code:#f5f7fb; --shadow:0 10px 24px rgba(2,12,27,.08);
  }
}
*{box-sizing:border-box}
html,body,#root{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Noto Sans JP, "Hiragino Kaku Gothic ProN", Meiryo, Arial, sans-serif}
.page{min-height:100%;display:flex;flex-direction:column}
.header{padding:36px 20px 12px;max-width:960px;margin:0 auto}
.brand{display:flex;align-items:center;gap:12px}
.logo{font-size:28px;filter: drop-shadow(0 3px 8px rgba(0,0,0,.25))}
h1{font-size:28px;letter-spacing:.2px;margin:0}
.subtitle{margin:6px 0 0;color:var(--muted)}
.main{max-width:960px;margin:20px auto 40px;padding:0 20px;width:100%}
.card{background:var(--panel);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);padding:18px}

.controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.state{margin-left:auto;color:var(--muted)}
.state.rec{color:#ff6666}
.state.proc{color:var(--primary-2)}
.btn{appearance:none;border:1px solid var(--border);background:var(--panel-2);color:var(--text);padding:10px 14px;border-radius:12px;cursor:pointer;transition:.15s ease;box-shadow:none}
.btn:hover{transform:translateY(-1px)}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.btn.primary{background:var(--primary);color:black;border-color:transparent}
.btn.primary:hover{filter:brightness(1.02)}
.btn.ghost{background:transparent}

.section{margin-top:18px;padding-top:8px;border-top:1px dashed var(--border)}
.section h3{margin:0 0 10px;font-size:16px;letter-spacing:.2px}
.kv{display:flex;gap:8px;align-items:center;margin:6px 0}
.kv-label{display:inline-block;min-width:68px;color:var(--muted)}
.kv-value{font-variant-numeric: tabular-nums}
.list{margin:0;padding-left:18px}
.list li{margin:6px 0}

.mono{font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:12.5px;background:var(--code);padding:12px;border-radius:10px;border:1px solid var(--border);overflow:auto}
.transcript{font-size:18px;line-height:1.9;background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:14px;white-space:pre-wrap;}
.transcript-actions{margin-top:8px;display:flex;gap:8px;}
.alert{margin-top:12px;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--panel-2)}
.alert.error{border-color: transparent; background: color-mix(in oklab, var(--danger) 12%, var(--panel)); color: #fff}

.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.minicard{background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:12px}
.minicard-head{font-weight:600;margin-bottom:8px;letter-spacing:.2px}

.metricbar{margin:10px 2px}
.metricbar-row{display:flex;justify-content:space-between;font-size:12px;opacity:.85}
.metricbar-num{font-variant-numeric:tabular-nums}
.metricbar-rail{height:8px;background:var(--panel);border:1px solid var(--border);border-radius:8px;margin-top:4px;overflow:hidden}
.metricbar-fill{height:100%;background:var(--primary);border-radius:8px;box-shadow:0 0 10px rgba(106,227,255,.25) inset}
.metricbar.missing{opacity:.55}
.metricbar.missing .metricbar-fill{box-shadow:none}

.updated-at{margin-top:8px;font-size:12px;opacity:.7}

/* AudioQualityPanel（compact化） */
.aq-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:4px}
.aq-col{display:flex;flex-direction:column;gap:8px}
.aq-title{display:flex;justify-content:space-between;align-items:center;font-weight:600}
.aq-title.head{margin-bottom:2px}
.aq-sub{font-size:12px;opacity:.7;margin-top:2px}
.aq-item{background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:8px}
.aq-rail{height:6px;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-top:6px}
.aq-fill{height:100%;background:var(--primary);box-shadow:0 0 10px rgba(106,227,255,.25) inset}
.aq-aux{font-size:12px;opacity:.8;margin-top:6px}
.badge{padding:2px 8px;border-radius:999px;background:var(--panel);border:1px solid var(--border);font-size:12px}
.pill{padding:4px 8px;border-radius:999px;background:var(--panel-2);border:1px solid var(--border);font-size:12px}
.pill.ok{background: color-mix(in oklab, var(--primary) 20%, var(--panel)); color:#fff; border-color: transparent}
.pill.low,.pill.high{background: color-mix(in oklab, var(--danger) 12%, var(--panel)); color: #fff; border-color: transparent}
.raw-toggle summary{cursor:pointer; opacity:.8; margin-top:8px}

.aq-advice{margin-top:8px;background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:10px}
.aq-advice-title{font-weight:700;margin-bottom:6px}
.aq-advice ul{margin:0;padding-left:18px}
/* 10項目ミニ表 */
.mini-kv-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
  gap:8px;
  margin-top:8px;
}
.mini-kv{
  background:var(--panel-2);
  border:1px solid var(--border);
  border-radius:10px;
  padding:8px;
  display:flex;
  align-items:center;
  justify-content:space-between;
}
.mini-kv .k{font-size:12px;opacity:.75;margin-right:8px}
.mini-kv .v{font-weight:600}
.aq-grid{
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
  grid-auto-flow: row dense;
  align-items: start;
}
.aq-grid .aq-col:first-child{ grid-column: 1 / -1; }

.aq-col{ gap: 6px; }
.aq-item{ padding: 8px; }
.aq-title.head{ margin-bottom: 0; }
.aq-sub{ margin-top: 0; }

.mini-kv-grid{ gap: 6px; margin-top: 6px; }
.mini-kv{ padding: 6px; }

/* ----- Logic (構造/論理性) ----- */
.logic { display: grid; gap: 10px; }
.logic-total { display:flex; align-items:baseline; gap:8px; margin-bottom:2px; }
.logic-total-num { font-size: 28px; font-weight: 800; }
.logic-total-sub { opacity: .7; }
.logic-bars .bar { display:grid; grid-template-columns: 140px 1fr 46px; gap:10px; align-items:center; }
.logic .subhead{ margin-top: 8px; font-weight:700; opacity:.85; }
.logic .list{ margin:0; padding-left:18px; line-height:1.6; }
      `}</style>
  );
}

