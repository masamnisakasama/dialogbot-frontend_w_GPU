import React, { useState, useEffect } from "react";
import RetrainButton from "./RetrainButton";

function App() {
  const [query, setQuery] = useState("最近AIの倫理について考えることが多いです");
  const [results, setResults] = useState([]);
  const [imageUrl, setImageUrl] = useState("");

  const fetchRecommendations = async () => {
    try {
      const res = await fetch(
        `http://localhost:8003/recommendations/with-explanation?query=${encodeURIComponent(query)}`
      );
      const data = await res.json();
      setResults(data);
    } catch (error) {
      console.error("レコメンド取得エラー:", error);
    }
  };

  const fetchImage = () => {
    // 画像ファイルはFastAPIが保存済みでないと動かないぽい
    setImageUrl("http://localhost:8003/plot?method=tsne");
  };

  useEffect(() => {
    fetchImage();
  }, []);

  return (
    <div style={{ padding: "2rem", fontFamily: "Arial, sans-serif" }}>
      <h2> 類似会話レコメンド</h2>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          width: "60%",
          padding: "0.5rem",
          marginRight: "1rem",
          fontSize: "16px",
        }}
      />
      <button
        onClick={fetchRecommendations}
        style={{
          padding: "0.5rem 1rem",
          fontSize: "16px",
          backgroundColor: "#007bff",
          color: "#fff",
          border: "none",
          borderRadius: "5px",
        }}
      >
        分析
      </button>

      <div style={{ marginTop: "2rem" }}>
        <h3> 類似結果:</h3>
        <ul>
          {results.map((item, idx) => (
            <li key={idx} style={{ marginBottom: "1rem" }}>
              <strong>会話ID:</strong> {item.id} <br />
              <strong>類似度:</strong> {item.similarity} <br />
              <strong>説明:</strong> {item.explanation_text}
            </li>
          ))}
        </ul>
      </div>

      <div style={{ marginTop: "2rem" }}>
        <h3> 可視化画像:</h3>
        {imageUrl && (
          <img
            src={imageUrl}
            alt="Embedding Visualization"
            width="600"
            style={{ border: "1px solid #ccc", borderRadius: "8px" }}
          />
        )}
      </div>

      <div style={{ marginTop: "2rem" }}>
        <h3> モデル再学習:</h3>
        <RetrainButton />
      </div>
    </div>
  );
}

export default App;
