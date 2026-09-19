from fastapi import FastAPI as Api, APIRouter
from flask import Flask
from celery import Celery
from kafka import KafkaProducer, KafkaConsumer
import requests
import httpx as hx
import aiohttp

app = Api()
router = APIRouter(prefix="/v1")
flask_app = Flask(__name__)
celery = Celery("worker")
producer = KafkaProducer()
consumer = KafkaConsumer("orders.created")
client = hx.Client()
session = aiohttp.ClientSession()

@app.get("/users/{user_id}")
def get_user():
    requests.get("https://php-api/wp-json/acme/v1/tip?token=discarded")

@router.post("/users")
def create_user():
    hx.request("PATCH", "https://php-api/wp-json/acme/v1/tip#discarded")
    client.get("https://php-api/item/42")
    session.delete("https://php-api/item/42")

@flask_app.route("/files/<path:name>/done", methods=["GET", "HEAD"])
def files():
    producer.send("orders.created", value={"secret": "not metadata"})
    consumer.subscribe(["orders.created", "orders.paid"])

@flask_app.route("/health")
def health():
    pass

@celery.task(name="orders.reconcile")
def reconcile():
    celery.send_task("orders.reconcile")
