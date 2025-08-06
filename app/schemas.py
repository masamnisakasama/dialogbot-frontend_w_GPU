from pydantic import BaseModel
from datetime import datetime

class ConversationCreate(BaseModel):
    user: str
    message: str

class Conversation(BaseModel):
    id: int
    user: str
    message: str
    timestamp: datetime
    style: str | None = None
    emotion: str | None = None
    emotional_intensity: str | None = None
    topic: str | None = None

    class Config:
        orm_mode = True
