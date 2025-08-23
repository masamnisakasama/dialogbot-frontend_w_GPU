// App.js
import React, { useState, useRef, useEffect, useCallback } from "react";
// App.jsとapi.jsでの２重定義回避　あとハードコーディング回避　env.variables
import { API_BASE } from "./config";


// アウトラインとアドバイスの表示　基本FalseでOK
const SHOW_OUTLINE = false;
const SHOW_ADVICE = false;

// アップロード/録音の最大サイズ & Whisperモデル(large-v3-turbo)
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // 24MB
const STT_MODEL = (process.env.REACT_APP_STT_MODEL || "large-v3-turbo").toLowerCase();

// 論理構造アドバイスのしきい値
const LOGIC_ADVICE_THRESH = {
  clarity: 75,
  consistency: 75,
  cohesion: 75,
  density: 60,
  cta: 60,
};

// バグだとわかるようヘルスチェッカー
const HEALTH_URL = `${API_BASE}/health`;
const HEALTH_INTERVAL_MS = Number(process.env.REACT_APP_HEALTH_INTERVAL_MS || 30000);

// 現在のユーザーIDを取得（window.__USER_ID__ → localStorage → sessionStorage → 既定 "web-client"）
function getCurrentUserId() {
  return (
    (typeof window !== "undefined" && window.__USER_ID__) ||
    (typeof window !== "undefined" &&
      window.localStorage &&
      window.localStorage.getItem("userId")) ||
    (typeof window !== "undefined" &&
      window.sessionStorage &&
      window.sessionStorage.getItem("userId")) ||
    "web-client"
  );
}

// プロンプトで固有名詞登録可能　音声認識精度上昇に
const STT_PROMPT =
  "ネビュラシステムズ,NovaDesk Assist,ヘルプデスク,一次回答,エスカレーション,バックログ," +
  "MTTA,MTTR,Confluence,SharePoint,Teams,Slack,Jira,ServiceNow,Azure AD,Okta,SAML,OIDC,SCIM";

// （他のAPI呼び出しで使う汎用fetch・ここでは主に GET/POSTのJSON取得用に）
async function fetchWithLongTimeout(
  url,
  options = {},
  ms = 60 * 60 * 1000,
  abortRef
) {
  const ctrl = new AbortController();
  if (abortRef) abortRef.current = ctrl;
  const id = setTimeout(() => ctrl.abort(new Error("timeout")), ms);

  try {
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
          <span className="flex-spacer" />
          
        </div>
        <p className="subtitle">
          音声をテキスト化して、プロファイルおよびアドバイスを行います。
        </p>
      </header>

      <main className="main">
        <Card>
          <SpeechToText />
        </Card>

        {/*  最近の傾向もいらないね　simple is best       
          <div style={{ height: 12 }} />

        <Card>
          <ProfilePanel userId={getCurrentUserId()} days={7} />
        </Card>

        <div style={{ height: 12 }} />
        */}

        {/* ★ S3の最近の結果一覧　セキュリティ上コメントアウトした
        <Card>
          <RecentResults userId={getCurrentUserId()} days={7} limit={30} />
        </Card>
        */}
      </main>
    </div>
  );
}

/* ============== 録音/ファイル → STT → ingest ============== */

function SpeechToText() {
  const MAX_REQUEST_MIN = 60;

  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  // —— 解析ステップ表示 ——
  const PIPELINE = [
    { key: "record", label: "録音/読込" },
    { key: "upload", label: "アップロード" },
    { key: "stt", label: "音声認識（STT）" },
    { key: "logic", label: "論理構造解析" },
    { key: "profile", label: "プロファイル反映" },
    { key: "done", label: "完了" },
  ];
  const initSteps = () =>
    PIPELINE.reduce((acc, s) => {
      acc[s.key] = { status: "todo", note: "" };
      return acc;
    }, {});
  const [steps, setSteps] = useState(() => initSteps());
  const [logicDone, setLogicDone] = useState(false);
  const [profileDone, setProfileDone] = useState(false);

  const setStep = (key, status, note = "") =>
    setSteps((prev) => ({ ...prev, [key]: { status, note, ts: Date.now() } }));

  const maybeFinish = () => {
    const needLogic = !!(result?.transcript || result?.text);
    if (profileDone && (!needLogic || logicDone)) {
      setStep("done", "done", "解析が完了しました");
    }
  };

  const onLogicPhase = (phase, note) => {
    if (phase === "start") {
      setStep("logic", "doing", "/論理構造把握中…");
      setLogicDone(false);
    } else if (phase === "done") {
      setStep("logic", "done");
      setLogicDone(true);
      maybeFinish();
    } else if (phase === "error") {
      setStep("logic", "error", note || "失敗しました");
    }
  };

  // —— 録音バッファなど ——
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const bytesRef = useRef(0);
  const overLimitRef = useRef(false);
  const abortRef = useRef(null);

  // —— アップロード進捗（追加） ——
  const [up, setUp] = useState({ loaded: 0, total: 0, pct: 0, speedBps: 0 });
  const fmtBytes = (b = 0) =>
    b < 1024
      ? `${b} B`
      : b < 1024 * 1024
      ? `${(b / 1024).toFixed(1)} KB`
      : `${(b / 1024 / 1024).toFixed(1)} MB`;
  const fmtSpeed = (bps = 0) =>
    bps < 1024
      ? `${bps.toFixed(0)} B/s`
      : bps < 1024 * 1024
      ? `${(bps / 1024).toFixed(1)} KB/s`
      : `${(bps / 1024 / 1024).toFixed(1)} MB/s`;

  // XHRでフォームを進捗付き送信（upload.onprogressを使う）
  async function uploadFormWithProgress(
    url,
    formData,
    { headers = {}, timeout = 60 * 60 * 1000, onProgress, abortRef } = {}
  ) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.responseType = "json";
      xhr.timeout = timeout;
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

      let lastLoaded = 0,
        lastT = performance.now();
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const now = performance.now();
        const bytesSec = (e.loaded - lastLoaded) / ((now - lastT) / 1000 || 1);
        lastLoaded = e.loaded;
        lastT = now;
        onProgress?.({
          loaded: e.loaded,
          total: e.total,
          pct: e.total ? (e.loaded / e.total) * 100 : 0,
          speedBps: bytesSec,
        });
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response ?? JSON.parse(xhr.responseText || "{}"));
        } else {
          reject(
            new Error(`HTTP ${xhr.status}: ${xhr.responseText || xhr.statusText}`)
          );
        }
      };
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.ontimeout = () => reject(new Error("タイムアウトしました"));
      xhr.onabort = () =>
        reject(Object.assign(new Error("中断しました"), { name: "AbortError" }));

      if (abortRef) abortRef.current = { abort: () => xhr.abort() };
      xhr.send(formData);
    });
  }

  const pickMimeType = () => {
    if (window.MediaRecorder?.isTypeSupported?.("audio/webm")) return "audio/webm";
    if (window.MediaRecorder?.isTypeSupported?.("audio/ogg")) return "audio/ogg";
    if (window.MediaRecorder?.isTypeSupported?.("audio/mp4")) return "audio/mp4";
    return "";
  };

  const resetPipeline = (mode) => {
    setSteps(initSteps());
    setLogicDone(false);
    setProfileDone(false);
    if (mode === "mic") {
      setStep("record", "doing", "マイク録音中…");
    } else if (mode === "file") {
      setStep("record", "done", "ファイルを読み込みました");
    }
  };

  const start = async () => {
    setError("");
    setResult(null);
    chunksRef.current = [];
    bytesRef.current = 0;
    overLimitRef.current = false;
    resetPipeline("mic");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
          bytesRef.current += e.data.size;
          if (bytesRef.current > MAX_UPLOAD_BYTES && mr.state !== "inactive") {
            overLimitRef.current = true;
            try {
              mr.stop();
            } catch {}
          }
        }
      };
      mr.onstop = async () => {
        setRecording(false);
        setStep("record", "done");
        await uploadOnce(stream);
      };

      mediaRecorderRef.current = mr;
      mr.start(200);
      setRecording(true);
    } catch (e) {
      setError(`マイク取得に失敗しました: ${e?.message || e}`);
      setStep("record", "error", "マイク許可/取得に失敗");
    }
  };

  const stop = () => {
    if (!mediaRecorderRef.current) return;
    if (mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.requestData?.();
      } catch {}
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  };

  // STTフォーム送信（XHRで進捗表示）
  const sendForm = async (formData) => {
    if (!formData.has("model")) formData.append("model", STT_MODEL);
    if (!formData.has("prompt") && STT_PROMPT) formData.append("prompt", STT_PROMPT);

    const tryOnce = async (url, ms = 60 * 60 * 1000, note = "") => {
      const u = new URL(url, window.location.origin);
      if (/^https?:\/\//i.test(url)) u.href = url;
      u.searchParams.set("detail", "true");
      u.searchParams.set("model", STT_MODEL);

      setStep("stt", "doing", note || "音声認識 実行中…");

      // 進捗リセット
      setUp({ loaded: 0, total: 0, pct: 0, speedBps: 0 });

      const json = await uploadFormWithProgress(u.toString(), formData, {
        headers: { "X-STT-Model": STT_MODEL, "X-User-Id": getCurrentUserId() },
        timeout: ms,
        abortRef,
        onProgress: (p) => setUp(p),
      });

      const transcript =
        json.text ?? json.transcript ?? json.result?.text ?? "";
      setResult({ ...json, transcript });
      setStep("stt", "done");
      return transcript;
    };

    try {
      return await tryOnce(`${API_BASE}/stt-full/`, undefined, "音声解析中...");
    } catch (e) {
      try {
        setStep("stt", "doing", "予備エンドポイントへフォールバック中…");
        return await tryOnce(
          `${API_BASE}/analyze/audio`,
          undefined,
          "今一度分析し直してください"　///analyze/audio機能しないがちなのでもうエラー表示
        );
      } catch (e2) {
        setStep("stt", "error", e2?.message || "STTに失敗しました");
        throw e2;
      }
    }
  };

  const ingestProfile = async (text) => {
    if (!text) return;
    try {
      setStep("profile", "doing", "プロファイルへ反映中…");
      await fetch(
        `${API_BASE}/profile/ingest?user_id=${encodeURIComponent(getCurrentUserId())}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Id": getCurrentUserId(),
          },
          body: JSON.stringify({ text }),
        }
      );
      window.dispatchEvent(new Event("profile-updated"));
      setStep("profile", "done");
      setProfileDone(true);
      maybeFinish();
    } catch (e) {
      setStep("profile", "error", e?.message || "プロファイル反映に失敗");
    }
  };

  const uploadOnce = async (stream) => {
    if (processing) return;
    setProcessing(true);
    setError("");
    setStep("upload", "doing", "アップロード中…");

    try {
      const mime = chunksRef.current[0]?.type || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mime });

      if (!blob || blob.size < 1024) {
        setError("音声データが空でした。2秒以上話してから停止してください。");
        setStep("upload", "error", "データが空");
        return;
      }

      if (overLimitRef.current || blob.size > MAX_UPLOAD_BYTES) {
        const mb = (blob.size / (1024 * 1024)).toFixed(2);
        setError(`録音データが大きすぎます（${mb}MB）。24MB以下にしてください。`);
        setStep("upload", "error", "24MB超過");
        return;
      }

      const filename =
        "voice." +
        (mime.includes("webm")
          ? "webm"
          : mime.includes("ogg")
          ? "ogg"
          : mime.includes("mp4")
          ? "mp4"
          : "webm");

      const fd = new FormData();
      fd.append("file", blob, filename);
      fd.append("user", getCurrentUserId());

      const text = await sendForm(fd);
      setStep("upload", "done");
      await ingestProfile(text);
    } catch (e) {
      if (e.name !== "AbortError")
        setError(`送信に失敗: ${e?.message || e}`);
      setStep("upload", "error", e?.message || "送信失敗");
    } finally {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}
      setProcessing(false);
    }
  };

  // 音声ファイルを直接アップロード（24MB制限あり）
  const onPickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    resetPipeline("file");

    if (file.size < 1024) {
      setError("ファイルサイズが小さすぎます（1KB未満）。");
      setStep("upload", "error", "ファイルが小さすぎます");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(2);
      setError(`ファイルが大きすぎます（${mb}MB）。24MB以下にしてください。`);
      setStep("upload", "error", "24MB超過");
      return;
    }
    setProcessing(true);
    setError("");
    setResult(null);
    setStep("upload", "doing", "アップロード中…");
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("user", getCurrentUserId());
      const text = await sendForm(fd);
      setStep("upload", "done");
      await ingestProfile(text);
    } catch (err) {
      if (err.name !== "AbortError")
        setError(`送信に失敗: ${err?.message || err}`);
      setStep("upload", "error", err?.message || "送信失敗");
    } finally {
      setProcessing(false);
    }
  };

  const cancel = () => {
    if (abortRef.current) abortRef.current.abort();
    setProcessing(false);
    ["upload", "stt"].forEach((k) => {
      if (steps[k]?.status === "doing") setStep(k, "error", "中断しました");
    });
  };

  const stateLabel = recording
    ? "録音中…"
    : processing
    ? "送信/解析中…"
    : "待機中";

  return (
    <>
     <div className="section-head">
  <h3>マイク/ファイルから解析</h3>
  {/* ランプ＋テキスト＋再試行 */}
  <HealthLamp compact showLabel showRetryText />
</div>
      <Alert
        text={`制限：音声ファイルは最大 ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(
          0
        )}MB、処理は最長 ${MAX_REQUEST_MIN} 分まで（超過時は中断されます）。長尺の解析中は「送信中断」でキャンセルできます。音声ファイルの長さは大体10分までにしてください。`}
      />

      {/* 解析ステップ */}
      <PipelineStatus pipeline={PIPELINE} steps={steps} />

      <div className="controls">
        <button
          className="btn primary"
          onClick={start}
          disabled={recording || processing}
        >
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
        <span className={`state ${recording ? "rec" : processing ? "proc" : ""}`}>
          {stateLabel}
        </span>
      </div>

      {/* 対応形式・上限（明記） */}
      <div className="muted smallhint">
        対応形式: WAV / MP3 / MP4 / OGG 　・　最大サイズ: 24MB
      </div>

      {/* アップロード進捗（例：2.2MB / 5.0MB（44%） • 1.2MB/s） */}
      {processing && up.total > 0 && (
        <div className="mono" style={{ marginTop: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <progress max={up.total} value={up.loaded} style={{ width: "220px" }} />
            <span>
              {fmtBytes(up.loaded)} / {fmtBytes(up.total)}（{Math.round(up.pct)}%）
              ・ {fmtSpeed(up.speedBps)}
            </span>
          </div>
        </div>
      )}

      {error && <Alert type="error" text={error} />}

      <ResultPanels result={result} onLogicPhase={onLogicPhase} />
    </>
  );
}

/* ============== 結果表示（音声メトリクス + 論理構造） ============== */

function buildLogicAdvice(logic) {
  const t = LOGIC_ADVICE_THRESH;
  const s = logic?.scores || {};
  const adv = [];

  if (Number.isFinite(s.clarity) && s.clarity < t.clarity) {
    adv.push(
      `「構成の明瞭さ」が基準値を下回っております（${Math.round(
        s.clarity
      )} / ${t.clarity}）。結論→理由→具体例→要約の順でお話しいただくと、より分かりやすくなります。文頭で要点を先にお示しください。`
    );
  }
  if (Number.isFinite(s.consistency) && s.consistency < t.consistency) {
    adv.push(
      `「論理的一貫性」が基準値を下回っております（${Math.round(
        s.consistency
      )} / ${t.consistency}）。用語や指標の表記を統一し、主張と根拠の対応関係をご確認ください。矛盾する表現は整理いただけると整います。`
    );
  }
  if (Number.isFinite(s.cohesion) && s.cohesion < t.cohesion) {
    adv.push(
      `「まとまり／結束性」が基準値を下回っております（${Math.round(
        s.cohesion
      )} / ${t.cohesion}）。段落のつなぎに「まず／次に／つまり／一方で／結果として」等の接続語を加え、指示語は具体語に置き換えていただくと流れが滑らかになります。`
    );
  }
  if (Number.isFinite(s.density) && s.density < t.density) {
    adv.push(
      `「要点密度」が基準値を下回っております（${Math.round(
        s.density
      )} / ${t.density}）。冗長な修飾を削り、数値・固有名詞・期限など情報量の高い語を前半に配置いただくと、密度が向上いたします。`
    );
  }
  if (Number.isFinite(s.cta) && s.cta < t.cta) {
    adv.push(
      `「CTAの明確さ」が基準値を下回っております（${Math.round(
        s.cta
      )} / ${t.cta}）。最後に「次に何をしてほしいか」を一文で明示ください（例：◯日までにご返信／デモのご予約はこちら／資料のダウンロードはこちら 等）。`
    );
  }
  return adv;
}

function ResultPanels({ result, onLogicPhase = () => {} }) {
  const [logic, setLogic] = useState(null);
  const [logicLoading, setLogicLoading] = useState(false);
  const [logicErr, setLogicErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const text = result?.transcript || result?.text || "";
      if (!text) {
        setLogic(null);
        return;
      }
      setLogicLoading(true);
      setLogicErr("");
      try {
        onLogicPhase("start");
        const res = await fetch(`${API_BASE}/analyze-logic`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Id": getCurrentUserId(),
          },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setLogic(data);
        onLogicPhase("done");
      } catch (e) {
        if (!cancelled) setLogicErr(e?.message || String(e));
        onLogicPhase("error", e?.message || String(e));
      } finally {
        if (!cancelled) setLogicLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
    
  }, [result?.transcript, result?.text]);

  if (!result) return null;

  return (
    <>
      {result?.transcript && (
        <Section title="テキスト">
          <div className="transcript">{result.transcript}</div>
          <div className="transcript-actions">
            <button
              className="btn"
              onClick={() => navigator.clipboard.writeText(result.transcript)}
            >
              📋 コピー
            </button>
          </div>
        </Section>
      )}

      {/* 論理構造（構成/論理性スコア） */}
      <Section title="論理構造">
        {!logic && !logicLoading && !logicErr && (
          <div className="muted">音声を解析すると表示されます。</div>
        )}
        {logicLoading && <div className="muted">解析中…</div>}
        {logicErr && (
          <Alert type="warn" text={`論理構造の取得に失敗しました：${logicErr}`} />
        )}
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
                  <span className="val">
                    {Math.round(logic?.scores?.[key] ?? 0)}
                  </span>
                </div>
              ))}
            </div>
            {SHOW_OUTLINE &&
              Array.isArray(logic.outline) &&
              logic.outline.length > 0 && (
                <>
                  <div className="subhead">検出アウトライン</div>
                  <ul className="list">
                    {logic.outline.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </>
              )}
            {SHOW_ADVICE &&
              Array.isArray(logic.advice) &&
              logic.advice.length > 0 && (
                <>
                  <div className="subhead">改善ヒント</div>
                  <ul className="list">
                    {logic.advice.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </>
              )}
          </div>
        )}
      </Section>

      <div className="grid">
        <Section title="メタ情報">
          <KV label="言語" value={result.language || "-"} />
          <KV
            label="処理時間"
            value={(result.duration_sec ?? 0).toFixed(2) + " sec"}
          />
          <KV label="使用モデル" value={result.model || "-"} />
        </Section>

        {/* スコア基準に基づくアドバイス */}
        {logic &&
          (() => {
            const adv = buildLogicAdvice(logic);
            return adv.length > 0 ? (
              <Section title="改善アドバイス（スコア基準）">
                <ul className="list">
                  {adv.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
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
    avgPause: [0.2, 0.6],
    density: [0.85, 0.99],
    segLen: [2.8, 5],
  };
  const band = (v, [lo, hi]) =>
    isNaN(v) ? "na" : v < lo ? "low" : v > hi ? "high" : "ok";
  const status = {
    cps: band(m.cps, R.cps),
    wpm: band(m.wpm, R.wpm),
    pauseRatio: band(m.pauseRatio, R.pauseRatio),
    avgPause: band(m.avgPause, R.avgPause),
    density: band(m.density, R.density),
    segLen: band(m.segLen, R.segLen),
  };

  const advice = [];
  if (status.cps === "high")
    advice.push(
      "話速がやや速めでいらっしゃいます。キーワードの前後に 0.2〜0.4 秒の間を意識していただくと、より聞き取りやすくなります。"
    );
  if (status.cps === "low")
    advice.push(
      "話速がややゆっくりでいらっしゃいます。文末の無音を少し短くし、接続詞でテンポを作っていただくと自然に感じられます。"
    );
  if (status.segLen === "high")
    advice.push(
      "1 セグメントがやや長い傾向でございます。3〜5 秒程度でお区切りいただくと、さらに明瞭になります。"
    );
  if (status.segLen === "low")
    advice.push(
      "1 セグメントが短い傾向でございます。文章の区切りごとの長さをもう少し長くしていただけると、より自然に聞こえます。"
    );

  const Gauge = ({ value, range, label, unit = "", aux }) => {
    const [lo, hi] = range;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const pct = isFinite(value)
      ? clamp(((value - lo) / (hi - lo)) * 100, 0, 100)
      : 0;
    return (
      <div className="aq-item">
        <div className="aq-title">
          <span>{label}</span>
          <span className="badge">
            {isFinite(value) ? `${value.toFixed(2)}${unit}` : "—"}
          </span>
        </div>
        <div className="aq-rail">
          <div className="aq-fill" style={{ width: `${pct}%` }} />
        </div>
        {aux && <div className="aq-aux">{aux}</div>}
      </div>
    );
  };

  const fmt = (v) =>
    typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : "—";
  const miniItems = [
    ["WPM（語/分）", m.wpm],
    ["CPS（文字/秒）", m.cps],
    ["有声時間(s)", m.voiced],
    ["平均セグメント(s)", m.segLen],
    ["セグメント数", m.segNum],
  ];

  return (
    <>
      <div className="aq-grid">
        <div className="aq-col">
          <div className="aq-title head">
            <span>話速</span>
            <span className="pill">
              {isJa ? `CPS: ${m.cps.toFixed(2)}` : `WPM: ${m.wpm ? m.wpm.toFixed(0) : "—"}`}
            </span>
          </div>
          <div className="aq-sub">
            {isJa ? "目安 3.0–5.0 文字/秒" : "目安 120–170 語/分"}
          </div>
          <Gauge value={m.cps} range={R.cps} label="CPS（文字/秒）" />
          {!isJa && <Gauge value={m.wpm} range={R.wpm} label="WPM（語/分）" />}
        </div>

        <div className="aq-col">
          <Gauge
            value={m.segLen}
            range={R.segLen}
            label="平均セグメント長"
            unit="s"
            aux={`セグメント ${m.segNum} 個 / 平均 ${m.segLen.toFixed(
              2
            )}s（目安 2.8–5.0s）`}
          />
          <div className="aq-item">
            <div className="aq-title">
              <span>有声時間</span>
              <span className="badge">{`${m.voiced.toFixed(1)}s`}</span>
            </div>
            <div className="aq-aux">
              （参考）全体 {durationSec ? `${durationSec.toFixed(1)}s` : "—"}
            </div>
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
            {advice.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function HealthLamp({ compact = false, showRetryText = false, showLabel = false, className = "" }) {
  // "online" | "offline" | "checking"
  const [status, setStatus] = React.useState("checking");
  const timerRef = React.useRef(null);
  const inflightRef = React.useRef(null);
  const HEALTH_INTERVAL_MS = Number(process.env.REACT_APP_HEALTH_INTERVAL_MS || 30000);

  const pingOnce = React.useCallback(async () => {
    if (inflightRef.current) return;
    const ctrl = new AbortController();
    inflightRef.current = ctrl;
    try {
      const res = await fetch(`${API_BASE}/health`, {
        method: "GET",
        signal: ctrl.signal,
        cache: "no-store",
        headers: { Accept: "application/json", "X-User-Id": getCurrentUserId() },
      });
      setStatus(res.ok ? "online" : "offline");
      return res.ok;
    } catch (e) {
      if (e?.name !== "AbortError") setStatus("offline");
      return false;
    } finally {
      inflightRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    let stopped = false;

    const initialCheck = async () => {
      setStatus("checking");
      let ok = await pingOnce();
      for (let i = 0; !ok && i < 2 && !stopped; i++) {
        await new Promise(r => setTimeout(r, 600));
        ok = await pingOnce();
      }
    };

    const loop = async () => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        timerRef.current = setTimeout(loop, HEALTH_INTERVAL_MS);
        return;
      }
      await pingOnce();
      timerRef.current = setTimeout(loop, HEALTH_INTERVAL_MS);
    };

    initialCheck().finally(() => {
      timerRef.current = setTimeout(loop, HEALTH_INTERVAL_MS);
    });

    return () => {
      stopped = true;
      clearTimeout(timerRef.current);
      timerRef.current = null;
      inflightRef.current?.abort?.();
      inflightRef.current = null;
    };
  }, [pingOnce, HEALTH_INTERVAL_MS]);

  const label =
    status === "online"   ? "接続良好"
  : status === "offline"  ? "接続エラー"
  :                         "確認中…";

  const handleRetry = () => {
    setStatus("checking");
    pingOnce();
  };

  return (
    <div
      className={`health ${status} ${compact ? "compact" : ""} ${className}`}
      title="サーバー状態を確認します"
      aria-live="polite"
    >
      {/*  CSS競合を回避しないとランプでないっぽいので　inlinestyleで確実に表示する */}
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          display: "inline-block",
          background:
            status === "online" ? "#22c55e" :
            status === "offline" ? "#ef4444" : "#f59e0b",
          boxShadow: status === "online" ? "0 0 0 3px rgba(34,197,94,.16) inset" : "none",
          marginRight: showLabel || showRetryText ? 6 : 0
        }}
      />
      {showLabel && <span className="label">
        {status === "online" ? "接続良好" : status === "offline" ? "接続エラー" : "確認中…"}
      </span>}
      {showRetryText && (
        <button className="retry" onClick={handleRetry} disabled={status === "checking"}>
          {status === "checking" ? "確認中…" : status === "offline" ? "再試行" : "再確認"}
        </button>
      )}
    </div>
  );
}




/* ============== プロファイル（Style/Mood/Interest） ============== */
// Open AI APIが明らかに重くなるし高いのでヒューリスティックを基本に

function ProfilePanel({ userId = "web-client", days = 7 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const STYLE_KEYS = [
    { key: "polite", label: "丁寧" },
    { key: "friendly", label: "フレンドリー" },
    { key: "assertive", label: "主張的" },
    { key: "empathetic", label: "共感的" },
    { key: "formal", label: "フォーマル" },
    { key: "casual", label: "カジュアル" },
    { key: "abstract", label: "抽象" },
    { key: "concrete", label: "具体" },
    { key: "concise", label: "簡潔" },
    { key: "verbose", label: "冗長" },
    { key: "expert", label: "専門" },
    { key: "explanatory", label: "解説的" },
    { key: "humorous", label: "ユーモア" },
    { key: "persuasive", label: "説得的" },
  ];
  const MOOD_KEYS = [
    { key: "pos", label: "ポジティブ" },
    { key: "neg", label: "ネガティブ" },
    { key: "arousal", label: "起伏" },
    { key: "calm", label: "落ち着き" },
    { key: "excited", label: "興奮" },
    { key: "confident", label: "自信" },
    { key: "anxious", label: "不安" },
    { key: "frustrated", label: "苛立ち" },
    { key: "satisfied", label: "満足" },
    { key: "curious", label: "好奇心" },
  ];
  const INTEREST_KEYS = [
    { key: "tech", label: "技術" },
    { key: "science", label: "科学" },
    { key: "art", label: "芸術" },
    { key: "design", label: "デザイン" },
    { key: "philo", label: "哲学" },
    { key: "business", label: "ビジネス" },
    { key: "finance", label: "ファイナンス" },
    { key: "history", label: "歴史" },
    { key: "literature", label: "文学" },
    { key: "education", label: "教育" },
    { key: "health", label: "健康" },
    { key: "sports", label: "スポーツ" },
    { key: "entertain", label: "エンタメ" },
    { key: "travel", label: "旅行" },
    { key: "food", label: "食" },
    { key: "gaming", label: "ゲーム" },
  ];

  const fetchProfile = async () => {
    setLoading(true);
    setErr("");
    try {
      const url = `${API_BASE}/profile/snapshot?user_id=${encodeURIComponent(
        userId
      )}&days=${days}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json", "X-User-Id": userId },
      });
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

  useEffect(() => {
    fetchProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, days]);
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
          {loading ? "更新中…" : "傾向の取得"}
        </button>
      </div>

      {err && <Alert type="error" text={err} />}

      {!data ? (
        <div className="mono">データを取得しています。</div>
      ) : (
        <>
          <div className="grid">
            <MiniCard title="Style">
              <BarsGroup dict={data.style || {}} keys={STYLE_KEYS} />
            </MiniCard>
            <MiniCard title="Mood">
              <BarsGroup dict={data.mood || {}} keys={MOOD_KEYS} />
            </MiniCard>
            <MiniCard title="Interest">
              <BarsGroup dict={data.interest || {}} keys={INTEREST_KEYS} />
            </MiniCard>
          </div>
          {/* 
          <div className="updated-at">
            更新: {safeDate(data.updated_at)} 
          </div>
          */}
        </>
      )}
    </>
  );
}

/* ============== S3 最近の結果（新規追加・両表記に対応） ============== */
/* 描画をコメントアウト中。Func RecenrResultsを戻すとS3の結果がフロントエンドに */

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
              <div
                className="metricbar-fill"
                style={{ width: isMissing ? "0%" : pct(v) }}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}

/* —— 解析ステップ UI —— */
function PipelineStatus({ pipeline, steps }) {
  return (
    <div className="pipe">
      {pipeline.map((p, idx) => {
        const st = steps[p.key]?.status || "todo";
        const note = steps[p.key]?.note || "";
        return (
          <div key={p.key} className={`step ${st}`}>
            <span className="dot" />
            <div className="step-text">
              <div className="step-label">{p.label}</div>
              {note && <div className="step-note">{note}</div>}
            </div>
            {idx < pipeline.length - 1 && <span className="arrow">›</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ============== UI Parts / Utils / Style ============== */

function Card({ children }) {
  return <div className="card">{children}</div>;
}
function MiniCard({ title, children }) {
  return (
    <div className="minicard">
      <div className="minicard-head">{title}</div>
      <div>{children}</div>
    </div>
  );
}
function Section({ title, children }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function KV({ label, value }) {
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className="kv-value">{value}</span>
    </div>
  );
}
function Alert({ type = "info", text }) {
  return <div className={`alert ${type}`}>{text}</div>;
}
function safeDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "-";
  }
}

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

.smallhint{margin-top:6px; font-size:12px}

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
.alert.warn{border-color: transparent; background: color-mix(in oklab, #f59e0b 18%, var(--panel)); color: #111}

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

/* ----- 解析ステップ ----- */
.pipe{
  display:flex; flex-wrap:wrap; gap:8px; align-items:stretch;
  margin: 0 0 8px;
}
.step{
  display:flex; align-items:center; gap:8px;
  background:var(--panel-2); border:1px solid var(--border);
  border-radius:999px; padding:6px 10px;
}
.step .dot{
  width:10px; height:10px; border-radius:50%;
  background:var(--muted);
}
.step .arrow{ opacity:.45; margin-left:2px }
.step.doing .dot{ background:var(--primary); box-shadow:0 0 0 0 color-mix(in oklab, var(--primary) 50%, #000); animation:pulse 1.4s infinite; }
.step.done  .dot{ background:#22c55e; }
.step.error .dot{ background:var(--danger); }
.step-text{ display:flex; flex-direction:column; gap:2px }
.step-label{ font-size:12.5px; font-weight:600 }
.step-note{ font-size:11.5px; opacity:.8 }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(106,227,255,.6); }
  70%{ box-shadow: 0 0 0 8px rgba(106,227,255,0); }
  100%{ box-shadow: 0 0 0 0 rgba(106,227,255,0); }

}
/* health chip */
.health{
  --chip:#9aa3b2;                 /* デフォルト色（unknown） */
  display:inline-flex; align-items:center; gap:10px;
  padding:6px 12px;
  border-radius:999px;
  /* ガラス調の下地＋ほんのり立体 */
  background:
    linear-gradient(180deg, color-mix(in oklab, var(--panel-2) 92%, black) 0%, var(--panel-2) 100%);
  border:1px solid color-mix(in oklab, var(--border) 75%, transparent);
  box-shadow:
    0 6px 20px rgba(0,0,0,.20),
    inset 0 1px 0 color-mix(in oklab, white 4%, transparent);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  transition: background .2s ease, border-color .2s ease, box-shadow .2s ease, transform .12s ease;
}

.health.compact{ padding:4px 10px; }

.health .dot{
  position:relative;
  width:12px; height:12px; border-radius:50%;
  background:var(--chip);
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--chip) 20%, transparent);
}

/* 状態ごとのアクセント色 */
.health.online   { --chip:#22c55e; }  /* 緑 */
.health.offline  { --chip:#ef4444; }  /* 赤 */
.health.checking { --chip:#f59e0b; }  /* 琥珀 */

/* 確認中はドットが鼓動 */
@keyframes blip {
  0%   { transform:scale(1);   opacity:.95; box-shadow:0 0 0 4px color-mix(in oklab, var(--chip) 22%, transparent); }
  100% { transform:scale(1.6); opacity:.35; box-shadow:0 0 0 9px color-mix(in oklab, var(--chip) 0%, transparent); }
}
.health.checking .dot::after{
  content:"";
  position:absolute; inset:0; border-radius:50%;
  background:var(--chip);
  opacity:.35;
  animation: blip 1.2s ease-out infinite;
}
.health .label{
  font-size:12.5px;
  font-weight:600;
  letter-spacing:.02em;
  opacity:.95;
}

/* おしゃれに行きたい */
.health .retry{
  appearance:none; border:1px solid color-mix(in oklab, var(--border) 60%, transparent);
  background: color-mix(in oklab, var(--chip) 10%, transparent);
  color:inherit;
  font-size:12px; padding:3px 8px; border-radius:8px;
  margin-left:2px; cursor:pointer;
  transition: transform .12s ease, background .15s ease, border-color .15s ease, opacity .15s ease;
}
.health .retry:hover{ transform:translateY(-1px); background:color-mix(in oklab, var(--chip) 16%, transparent); }
.health .retry:active{ transform:translateY(0); }
.health .retry:disabled{ opacity:.55; cursor:not-allowed; }

/* 見出しと綺麗に並べる */
.section-head{
  display:flex; align-items:baseline; gap:12px; margin:0 0 8px; flex-wrap:wrap;
}
.section-head h3{ margin:0; line-height:1.2; }
      `}</style>
      
  );
}