from fastapi import FastAPI
from app.schemas import ConversationCreate, Conversation
from app.features import classify_dialogue_style
from datetime import datetime

app = FastAPI()

# 簡易的なメモリ上DB（実運用時はDBに置き換え）
fake_db = []
conversation_id = 1

@app.post("/conversations/", response_model=Conversation)
def create_conversation(conv: ConversationCreate):
    global conversation_id

    # GPTによるスタイル・感情判定
    result = classify_dialogue_style(conv.message)

    conversation = {
        "id": conversation_id,
        "user": conv.user,
        "message": conv.message,
        "timestamp": datetime.utcnow(),
        "style": result.get("style"),
        "emotion": result.get("emotion"),
        "emotional_intensity": result.get("emotional_intensity"),
        "topic": result.get("topic")
    }

    fake_db.append(conversation)
    conversation_id += 1

    return conversation


@app.get("/")
def root():
    return {"message": "Continuous DialogBot API is running."}
