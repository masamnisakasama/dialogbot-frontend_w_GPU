from fastapi import APIRouter, BackgroundTasks
from sqlalchemy.orm import Session
from app import crud, database, features
import logging

router = APIRouter()

# ロガー設定
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

# 再学習タスク本体
def retrain_model():
    logger.info("🔁 [retrain_model] 再学習を開始します")
    db: Session = database.SessionLocal()
    try:
        conversations = crud.get_all_conversations(db)
        if not conversations:
            logger.warning("⚠️ 再学習対象の会話データが存在しません")
            return

        # t-SNEとPCAでの可視化を行う
        features.visualize_embeddings(conversations, method="tsne")
        logger.info("✅ TSNEによる可視化画像の生成が完了しました")

        features.visualize_embeddings(conversations, method="pca")
        logger.info("✅ PCAによる可視化画像の生成が完了しました")

        # 将来的にモデル再学習処理をここに追加可能

    except Exception as e:
        logger.error(f"❌ 再学習中にエラーが発生しました: {e}")
    finally:
        db.close()
        logger.info("🔚 [retrain_model] 再学習処理が終了しました")

# APIエンドポイント
@router.post("/retrain")
async def trigger_retrain(background_tasks: BackgroundTasks):
    """
    会話データの再学習（再可視化）を非同期で実行するエンドポイント。
    """
    background_tasks.add_task(retrain_model)
    logger.info("📩 再学習タスクをバックグラウンドでキューに追加しました")
    return {"message": "再学習処理をバックグラウンドで開始しました"}
