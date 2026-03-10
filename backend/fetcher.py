import httpx
import re
import json
import asyncio
import math
from datetime import datetime
from typing import List, Dict, Any

from .database import SessionLocal, Fund

# 东方财富 API 基础常量
EASTMONEY_SPOT_PAGE_SIZE = 100
EASTMONEY_SPOT_BASE_URL = f"https://push2.eastmoney.com/api/qt/clist/get?pz={EASTMONEY_SPOT_PAGE_SIZE}&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f20&fs=b:MK0404,b:MK0405,b:MK0406,b:MK0407&fields=f1,f2,f3,f12,f14,f15,f16,f17,f18,f20,f62,f124,f152"

NAV_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'zh-HK,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'DNT': '1',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
}

def safe_float(val: Any) -> float:
    try:
        return float(val) if val not in ["-", ""] else 0.0
    except (ValueError, TypeError):
        return 0.0

def format_unix_sec(sec: Any) -> str:
    try:
        n = int(sec)
        if n <= 0: return ""
        d = datetime.fromtimestamp(n)
        return d.strftime("%H:%M")
    except (ValueError, TypeError):
        return ""

async def fetch_page(client: httpx.AsyncClient, pn: int) -> dict:
    url = f"{EASTMONEY_SPOT_BASE_URL}&pn={pn}"
    resp = await client.get(url, timeout=10.0)
    resp.raise_for_status()
    return resp.json()

def parse_diff(data: dict) -> List[Dict]:
    diff = data.get("data", {}).get("diff", [])
    if not isinstance(diff, list):
        return []
        
    parsed = []
    for item in diff:
        code = item.get("f12")
        price = safe_float(item.get("f2"))
        if not code or price <= 0:
            continue
            
        parsed.append({
            "code": code,
            "name": item.get("f14", ""),
            "price": price,
            "change": safe_float(item.get("f3")),
            "high": safe_float(item.get("f15")),
            "low": safe_float(item.get("f16")),
            "open": safe_float(item.get("f17")),
            "pre_close": safe_float(item.get("f18")),
            "volume": safe_float(item.get("f20")),
            "price_time": format_unix_sec(item.get("f124"))
        })
    return parsed

async def fetch_all_lof_spots() -> List[Dict]:
    async with httpx.AsyncClient() as client:
        first = await fetch_page(client, 1)
        total = first.get("data", {}).get("total", 0)
        items = parse_diff(first)
        
        total_pages = math.ceil(total / EASTMONEY_SPOT_PAGE_SIZE)
        if total_pages > 1:
            tasks = [fetch_page(client, pn) for pn in range(2, total_pages + 1)]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for res in results:
                if isinstance(res, dict):
                    items.extend(parse_diff(res))
        
        # 去重
        seen = set()
        deduped = []
        for i in items:
            if i["code"] not in seen:
                seen.add(i["code"])
                deduped.append(i)
                
        return deduped

async def fetch_nav_fundgz(client: httpx.AsyncClient, code: str) -> dict:
    url = f"https://fundgz.1234567.com.cn/js/{code}.js?rt={int(datetime.now().timestamp() * 1000)}"
    try:
        resp = await client.get(url, headers=NAV_HEADERS, timeout=8.0)
        text = resp.text
        match = re.search(r'jsonpgz\((.*?)\)', text)
        if match:
            # 可能是 jsonpgz() 空调用
            inner = match.group(1).strip()
            if not inner:
                return {}
                
            data = {}
            try:
                data = json.loads(inner)
            except json.JSONDecodeError:
                # API 有时返回包含未转义字符(比如名字里的引号)的残缺 JSON，导致 loads 报错。
                # 由于我们不需要 name，此时直接降级用正则精准提取我们需要的关键数值字段。
                for key in ["gsz", "dwjz", "gztime", "jzrq"]:
                    m = re.search(f'"{key}"\\s*:\\s*"([^"]*)"', inner)
                    if m:
                        data[key] = m.group(1)
                        
            gsz = safe_float(data.get("gsz"))
            dwjz = safe_float(data.get("dwjz"))
            nav = gsz if gsz > 0 else (dwjz if dwjz > 0 else 0)
            nav_time = (data.get("gztime") or data.get("jzrq") or "").strip()
            return {"nav": nav, "nav_time": nav_time} if nav > 0 else {}
    except Exception as e:
        print(f"fundgz error for {code}: {e}")
    return {}

async def fetch_nav_pingzhong(client: httpx.AsyncClient, code: str) -> dict:
    url = f"https://fund.eastmoney.com/pingzhongdata/{code}.js?v={int(datetime.now().timestamp() * 1000)}"
    try:
        resp = await client.get(url, headers=NAV_HEADERS, timeout=8.0)
        text = resp.text
        match = re.search(r'var Data_netWorthTrend\s*=\s*(\[.*?\]);', text)
        if match:
            trend = json.loads(match.group(1))
            if trend and len(trend) > 0:
                latest = trend[-1]
                nav = safe_float(latest.get("y"))
                # timestamp in ms
                ts = safe_float(latest.get("x"))
                nav_time = ""
                if ts > 0:
                    d = datetime.fromtimestamp(ts / 1000.0)
                    nav_time = d.strftime("%Y-%m-%d")
                return {"nav": nav, "nav_time": nav_time} if nav > 0 else {}
    except Exception as e:
        print(f"pingzhong error for {code}: {e}")
    return {}

async def fetch_nav_single(code: str) -> dict:
    async with httpx.AsyncClient() as client:
        res = await fetch_nav_fundgz(client, code)
        if not res.get("nav"):
            res = await fetch_nav_pingzhong(client, code)
        return res

async def sync_spots_to_db():
    spots = await fetch_all_lof_spots()
    db = SessionLocal()
    try:
        updated = 0
        for spot in spots:
            fund = db.query(Fund).filter(Fund.code == spot["code"]).first()
            if not fund:
                fund = Fund(code=spot["code"])
                db.add(fund)
                
            fund.name = spot["name"]
            fund.price = spot["price"]
            fund.change = spot["change"]
            fund.high = spot["high"]
            fund.low = spot["low"]
            fund.open = spot["open"]
            fund.pre_close = spot["pre_close"]
            fund.volume = spot["volume"]
            fund.price_time = spot["price_time"]
            
            # Recalculate premium if nav exists
            if fund.nav and fund.price and fund.nav > 0:
                fund.premium = (fund.price - fund.nav) / fund.nav * 100
                
            updated += 1
            
        db.commit()
        print(f"[Sync] Spotlight synced {updated} funds.")
    finally:
        db.close()

async def sync_nav_to_db(code: str):
    res = await fetch_nav_single(code)
    if not res.get("nav"):
        return False
        
    db = SessionLocal()
    try:
        fund = db.query(Fund).filter(Fund.code == code).first()
        if not fund:
            return False
            
        fund.nav = res["nav"]
        fund.nav_time = res["nav_time"]
        if fund.price and fund.nav > 0:
            fund.premium = (fund.price - fund.nav) / fund.nav * 100
            
        db.commit()
        return True
    finally:
        db.close()

async def sync_all_navs_to_db():
    db = SessionLocal()
    try:
        funds = db.query(Fund).all()
        codes = [f.code for f in funds]
    finally:
        db.close()
        
    updated = 0
    for code in codes:
        try:
            success = await sync_nav_to_db(code)
            if success:
                updated += 1
        except Exception as e:
            print(f"[Sync NAV Error] {code}: {e}")
            
        await asyncio.sleep(0.5) # 防封禁延迟
        
    print(f"[Sync] NAV bulk sync completed: {updated}/{len(codes)} updated.")
