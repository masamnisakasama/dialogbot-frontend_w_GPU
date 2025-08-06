from sqlalchemy.orm import Session
from app import models, schemas
from typing import List

def create_conversation(db: Session, conv: schemas.ConversationCreate, analysis: dict, embedding: bytes):
    db_conv = models.Conversation(
        user=conv.user,
        message=conv.message,
        style=analysis.get("style"),
        emotion=analysis.get("emotion"),
        emotional_intensity=analysis.get("emotional_intensity"),
        topic=analysis.get("topic"),
        embedding=embedding
    )
    db.add(db_conv)
    db.commit()
    db.refresh(db_conv)
    return db_conv

def get_all_conversations(db: Session) -> List[models.Conversation]:
    return db.query(models.Conversation).all()
