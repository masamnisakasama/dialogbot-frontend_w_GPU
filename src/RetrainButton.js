import React, { useState } from "react";

const RetrainButton = () => {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const handleRetrain = async () => {
    setLoading(true);
    setMessage("");

    try {
      const response = await fetch("http://127.0.0.1:8002/mlops/retrain", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("APIリクエストに失敗しました");
      }

      const data = await response.json();
      setMessage(data.message || "再学習が開始されました");
    } catch (error) {
      console.error("再学習エラー:", error);
      setMessage("再学習の開始に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop: "20px" }}>
      <button
        onClick={handleRetrain}
        disabled={loading}
        style={{
          padding: "10px 20px",
          fontSize: "16px",
          backgroundColor: loading ? "#ccc" : "#4CAF50",
          color: "#fff",
          border: "none",
          borderRadius: "5px",
          cursor: loading ? "not-allowed" : "pointer",
        }}
      >
        {loading ? "再学習中..." : "再学習を開始する"}
      </button>
      {message && (
        <p style={{ marginTop: "10px", color: "#333" }}>
          {message}
        </p>
      )}
    </div>
  );
};

export default RetrainButton;
