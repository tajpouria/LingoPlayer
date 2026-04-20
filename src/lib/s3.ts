import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env';

const s3 = new S3Client({ region: env.s3Region });

function safeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

function userKey(email: string, file: string): string {
  return `${env.s3PathPrefix}/${safeEmail(email)}/${file}`;
}

export async function ensureUserFolder(email: string): Promise<void> {
  const key = userKey(email, '.profile.json');
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.s3Bucket, Key: key }));
  } catch {
    await s3.send(new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
      Body: JSON.stringify({ email, createdAt: new Date().toISOString() }),
      ContentType: 'application/json',
    }));
  }
}

export async function readUserJson<T>(email: string, file: string, fallback: T): Promise<T> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: env.s3Bucket, Key: userKey(email, file) }));
    const body = await res.Body?.transformToString();
    return body ? JSON.parse(body) : fallback;
  } catch {
    return fallback;
  }
}

export async function writeUserJson(email: string, file: string, data: unknown): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: env.s3Bucket,
    Key: userKey(email, file),
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));
}
