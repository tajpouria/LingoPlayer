import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env';

const s3 = new S3Client({ region: env.s3Region });

function userKey(email: string): string {
  // Sanitize email for use as S3 key prefix
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return `${env.s3PathPrefix}/${safe}/.profile.json`;
}

export async function ensureUserFolder(email: string): Promise<void> {
  const key = userKey(email);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.s3Bucket, Key: key }));
  } catch {
    // Create profile marker
    await s3.send(new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
      Body: JSON.stringify({ email, createdAt: new Date().toISOString() }),
      ContentType: 'application/json',
    }));
  }
}
