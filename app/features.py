import os
import openai
import json
from dotenv import load_dotenv

load_dotenv()
openai.api_key = os.getenv("OPENAI_API_KEY")

def classify_dialogue_style(text: str) -> dict:
    system_prompt = """
あなたは会話スタイルの専門家です。ユーザーの発言を読み取り、次のカテゴリに分類してください：

1. 表現スタイル（次の中から1つ）：
- 丁寧
- カジュアル
- 簡潔
- 抽象的
- 専門的

2. 感情（次の中から1つ）：
- ポジティブ
- ネガティブ
- ニュートラル

3. 感情の起伏（次の中から1つ）：
- 大きい
- 普通
- 小さい

4. 話題ジャンル（次の中から1つ）：
- 技術
- 哲学
- 芸術
- 社会
- 雑談

出力は次のJSON形式で返してください：

{
  "style": "",
  "emotion": "",
  "emotional_intensity": "",
  "topic": ""
}
"""

    user_prompt = f"以下の発言を分析してください：\n{text}"

    try:
        response = openai.chat.completions.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.3,
            timeout=10
        )
        content = response.choices[0].message.content
        return json.loads(content)

    except Exception as e:
        import traceback
        print("OpenAI API 呼び出し時の例外発生:")
        traceback.print_exc()
        return {
            "style": "不明",
            "emotion": "不明",
            "emotional_intensity": "不明",
            "topic": "不明"
        }
