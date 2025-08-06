from fastapi import FastAPI, Depends, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from app import database, models, crud, features, schemas

from dotenv import load_dotenv

# retrain.py の router をインポート
from app.mlops.retrain import router as retrain_router  # 例：mlopsフォルダ内 retrain.py に router 定義してある想定

load_dotenv()
models.Base.metadata.create_all(bind=database.engine)

app = FastAPI()

# CORS設定（Reactのlocalhost:3000からのアクセスを許可）
origins = [
    "http://localhost:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    db = database.SessionLocal()
    try:
        yield db
    finally:
        db.close()

@app.post("/conversations/", response_model=schemas.Conversation)
def create_conversation(conv: schemas.ConversationCreate, db: Session = Depends(get_db)):
    embedding = features.get_embedding(conv.message)
    analysis = features.classify_dialogue_style(conv.message)
    db_conv = crud.create_conversation(db, conv, analysis, embedding)
    return db_conv

@app.get("/recommendations/with-explanation")
def get_recommendations_with_explanation(query: str, db: Session = Depends(get_db)):
    all_convs = crud.get_all_conversations(db)
    results = features.recommend_similar_conversations(query, all_convs, explain=True)
    response = []
    for conv, sim, explanation, explanation_text in results:
        response.append({
            "id": conv.id,
            "similarity": round(sim, 4),
            "top_dimensions": explanation,
            "explanation_text": explanation_text
        })
    return JSONResponse(content=response)

@app.get("/recommendations/", response_model=list[schemas.Conversation])
def get_recommendations(query: str, db: Session = Depends(get_db)):
    all_convs = crud.get_all_conversations(db)
    top_convs = features.recommend_similar_conversations(query, all_convs)
    return top_convs

@app.get("/visualize/image")
def get_visualization_image(method: str = "tsne"):
    filename = f"embedding_{method}.png"
    try:
        return FileResponse(filename, media_type="image/png")
    except Exception:
        return {"error": "画像が存在しません。先に画像生成APIを呼んでください。"}

# ここで retrain.py の router を /mlops パス配下に登録
app.include_router(retrain_router, prefix="/mlops")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="127.0.0.1", port=8002, reload=True)
