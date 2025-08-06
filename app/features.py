import os
import pickle
import json
import numpy as np
import openai
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv
import matplotlib.pyplot as plt
from sklearn.manifold import TSNE
from sklearn.decomposition import PCA

load_dotenv()

openai.api_key = os.getenv("OPENAI_API_KEY")
bert_model = SentenceTransformer("all-MiniLM-L6-v2")

def get_embedding(text: str) -> bytes:
    embedding = bert_model.encode(text)
    return pickle.dumps(embedding)

def classify_dialogue_style(text: str) -> dict:
    """
    GPT-4に発言のスタイル、感情、感情強度、トピックを
    JSON形式で返してもらう（より精密なプロンプト使用）
    """
    system_prompt = """
    あなたは会話分析の専門家です。  
    これから渡す日本語の発言について、以下の4つの属性をJSON形式で返してください。  
    - style（話し方のスタイル）：丁寧、カジュアル、フレンドリー、専門的、簡潔、抽象的などの中から最も近いもの  
    - emotion（感情）：喜び、怒り、悲しみ、驚き、恐怖、嫌悪、ニュートラル、その他（わからなければ'不明'）  
    - emotional_intensity（感情の強さ）：小さい、中くらい、大きい  
    - topic（話題）：技術、芸術、哲学、趣味、仕事、家庭、ニュース、その他（わからなければ'不明'）

    JSONのフォーマットは以下のようにしてください（ダブルクオーテーション、プロパティ名は必ずこの名前で）：
    {
        "style": "...",
        "emotion": "...",
        "emotional_intensity": "...",
        "topic": "..."
    }
    """

    user_prompt = f"発言: {text}"

    try:
        response = openai.chat.completions.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": system_prompt.strip()},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
            max_tokens=150,
        )
        content = response.choices[0].message.content.strip()

        # JSONパース
        try:
            result = json.loads(content)
        except json.JSONDecodeError:
            result = {
                "style": "不明",
                "emotion": "不明",
                "emotional_intensity": "不明",
                "topic": "不明",
            }

        for key in ["style", "emotion", "emotional_intensity", "topic"]:
            if key not in result:
                result[key] = "不明"

        return result

    except Exception as e:
        print("OpenAI API 呼び出し時の例外発生:", e)
        return {
            "style": "不明",
            "emotion": "不明",
            "emotional_intensity": "不明",
            "topic": "不明",
        }

def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """コサイン類似度計算"""
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

def get_vector_explanation(a: np.ndarray, b: np.ndarray, top_k: int = 5) -> list:
    """類似度に寄与する上位k次元を抽出"""
    contribution = a * b
    top_dims = np.argsort(contribution)[-top_k:][::-1]
    return top_dims.tolist()

def generate_natural_language_explanation(query: str, target: str) -> str:
    """類似理由の自然言語説明生成"""
    try:
        prompt = f"""
        あなたは会話スタイル解析の専門家です。以下の2つの発言がなぜ似ていると判断できるかを日本語で説明してください。

        発言1: {query}
        発言2: {target}

        類似点、話題、感情、文体などに触れてください。
        """
        response = openai.chat.completions.create(
            model="gpt-4",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            max_tokens=200,
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        return f"説明の生成に失敗しました: {str(e)}"

def recommend_similar_conversations(query_text: str, conversations: list, explain: bool = False) -> list:
    """
    類似会話を取得。explain=Trueで寄与次元や自然言語説明も取得
    """
    query_vec = bert_model.encode(query_text)
    similarities = []

    for conv in conversations:
        if conv.embedding:
            emb = pickle.loads(conv.embedding)
            sim = cosine_similarity(query_vec, emb)
            explanation = get_vector_explanation(query_vec, emb) if explain else []
            explanation_text = None
            if explain:
                explanation_text = generate_natural_language_explanation(query_text, conv.message)
            similarities.append((sim, conv, explanation, explanation_text))

    similarities.sort(reverse=True, key=lambda x: x[0])
    top_convs = [(conv, sim, explanation, explanation_text) for sim, conv, explanation, explanation_text in similarities[:5]]
    return top_convs

def generate_clustering_image(embeddings: list[bytes], method: str = "tsne"):
    """
    埋め込みの次元削減と散布図生成（TSNEかPCAを選択）
    """
    vectors = [pickle.loads(e) for e in embeddings if e is not None]
    if not vectors:
        raise ValueError("Embeddingが空です")

    if method == "tsne":
        reducer = TSNE(n_components=2, random_state=42)
    elif method == "pca":
        reducer = PCA(n_components=2)
    else:
        raise ValueError("methodは'tsne'または'pca'を指定してください")

    reduced = reducer.fit_transform(vectors)

    plt.figure(figsize=(8, 6))
    plt.scatter(reduced[:, 0], reduced[:, 1], c='blue', alpha=0.5)
    plt.title(f"{method.upper()} Clustering Visualization")
    plt.savefig(f"embedding_{method}.png")
    plt.close()
