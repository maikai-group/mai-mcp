import axios from 'axios';
import { Kafka } from 'kafkajs';

interface RouterLike {
  get(route: string, handler: () => void): void;
  all(route: string, handler: () => void): void;
}

const app: RouterLike = {
  get: (_route: string, _handler: () => void): void => undefined,
  all: (_route: string, _handler: () => void): void => undefined,
};

app.get('/health', () => undefined);
app.all('/files/:name', () => undefined);

void fetch('https://python-api/users/42?token=discarded#fragment');
void fetch('https://python-api/users', { method: 'POST', headers: { authorization: 'discarded' } });
void axios.get('https://python-api/users/42');
void axios.post('https://python-api/users', { body: 'discarded' });
void axios({ url: 'https://python-api/users', method: 'put' });
void axios.request({ url: 'https://python-api/users/42', method: 'PATCH' });

const kafka = new Kafka({ clientId: 'fixture', brokers: ['localhost:9092'] });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'fixture' });
void producer.send({ topic: 'orders.created', messages: [] });
void consumer.subscribe({ topic: 'orders.created' });
void consumer.subscribe({ topics: ['orders.created', 'orders.paid'] });

function shadowed(fetch: (url: string) => void): void {
  fetch('https://ignored.invalid/shadowed');
}
void shadowed;

const client = { get: (_url: string): void => undefined };
client.get('https://ignored.invalid/unrelated');
