import os
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime

# 数据目录
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
os.makedirs(DATA_DIR, exist_ok=True)

DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{os.path.join(DATA_DIR, 'lof.db')}")

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class Fund(Base):
    __tablename__ = "lof_funds"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(20), unique=True, index=True)
    name = Column(String(255))
    
    # 场内行情
    price = Column(Float, nullable=True)
    change = Column(Float, nullable=True)
    high = Column(Float, nullable=True)
    low = Column(Float, nullable=True)
    open = Column(Float, nullable=True)
    pre_close = Column(Float, nullable=True)
    volume = Column(Float, nullable=True)
    price_time = Column(String(50), nullable=True) # HH:mm
    
    # 场外净值
    nav = Column(Float, nullable=True)
    nav_time = Column(String(50), nullable=True) # e.g. 15:00 or 2024-01-01
    
    # 结果
    premium = Column(Float, nullable=True)
    
    # 元数据
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
