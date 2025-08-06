from sqlalchemy.orm import Session
from . import models, schemas
from .features import classify_dialogue_style

def create_conversation(db: Session, conversation: schemas.ConversationCreate):
    style_info = classify_dialogue_style(conversation.message)

    db_convo = models.Conversation(
        user=conversation.user,
        message=conversation.message,
        style=style_info.get("style"),
        emotion=style_info.get("emotion"),
        emotional_intensity=style_info.get("emotional_intensity"),
        topic=style_info.get("topic"),
    )
    db.add(db_convo)
    db.commit()
    db.refresh(db_convo)
    return db_convo

def get_conversations(db: Session, skip: int = 0, limit: int = 100):
    return db.query(models.Conversation).offset(skip).limit(limit).all()
