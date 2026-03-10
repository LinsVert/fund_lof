from fastapi import FastAPI, BackgroundTasks, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import asyncio
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .database import Base, engine, get_db, Fund
from .fetcher import sync_spots_to_db, sync_nav_to_db, sync_all_navs_to_db

app = FastAPI(title="LOF Premium Monitor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

scheduler = AsyncIOScheduler()

@app.on_event("startup")
async def startup_event():
    # Retry logic for database connection (MySQL might take a few seconds to start)
    max_retries = 10
    for i in range(max_retries):
        try:
            Base.metadata.create_all(bind=engine)
            print("Successfully connected to the database and initialized tables.")
            break
        except Exception as e:
            if i < max_retries - 1:
                print(f"Database connection failed, retrying in 3 seconds... ({i+1}/{max_retries})")
                await asyncio.sleep(3)
            else:
                print("Failed to connect to the database after several retries.")
                raise e
    
    # 启动时先拉取一次行情
    asyncio.create_task(sync_spots_to_db())
    
    # 定时任务：交易日每 5 分钟刷新一次行情
    scheduler.add_job(sync_spots_to_db, 'cron', day_of_week='mon-fri', hour='9-15', minute='*/5')

    # 定时任务：工作日 21:00 全量更新所有净值
    scheduler.add_job(sync_all_navs_to_db, 'cron', day_of_week='mon-fri', hour=21, minute=0)
    
    scheduler.start()

@app.on_event("shutdown")
async def shutdown_event():
    scheduler.shutdown()

@app.get("/api/funds")
def get_funds(db: Session = Depends(get_db)):
    # MySQL 默认认为 NULL 比任何值都小，因此在 DESC 排序中 NULL 自然会排在最后。
    # 移除 SQLite 环境专用的 .nulls_last()，避免 MySQL 报错。
    funds = db.query(Fund).order_by(Fund.premium.desc()).all()
    # 转换为字典列表
    return [
        {
            "code": f.code,
            "name": f.name,
            "price": f.price,
            "nav": f.nav,
            "premium": f.premium,
            "change": f.change,
            "high": f.high,
            "low": f.low,
            "open": f.open,
            "preClose": f.pre_close,
            "volume": f.volume,
            "priceTime": f.price_time,
            "navTime": f.nav_time,
            "updatedAt": f.updated_at.isoformat() if f.updated_at else None
        }
        for f in funds
    ]

@app.post("/api/fetch/spot")
async def fetch_spot_manual(background_tasks: BackgroundTasks):
    # 手动触发刷新全量行情
    background_tasks.add_task(sync_spots_to_db)
    return {"status": "ok", "message": "Spot fetch task started in background."}

@app.post("/api/fetch/navs/all")
async def fetch_all_navs_manual(background_tasks: BackgroundTasks):
    # 手动触发刷新全量净值 (Debug)
    background_tasks.add_task(sync_all_navs_to_db)
    return {"status": "ok", "message": "All NAVs sync task started in background."}

@app.post("/api/fetch/nav/{code}")
async def fetch_nav_manual(code: str, background_tasks: BackgroundTasks):
    # 手动触发刷新单支基金净值
    background_tasks.add_task(sync_nav_to_db, code)
    return {"status": "ok", "message": f"NAV fetch task for {code} started in background."}

# Mount frontend static files last
import os
frontend_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
