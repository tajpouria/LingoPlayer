// Validated env access — fails fast at startup if misconfigured

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const env = {
  get jwtSecret() { return req('JWT_SECRET'); },
  get smtpHost() { return req('SMTP_HOST'); },
  get smtpPort() { return parseInt(req('SMTP_PORT'), 10); },
  get smtpSecure() { return process.env.SMTP_SECURE === 'true'; },
  get smtpUser() { return req('SMTP_USER'); },
  get smtpPass() { return req('SMTP_PASS'); },
  get emailFrom() { return req('EMAIL_FROM'); },
  get s3Bucket() { return req('S3_BUCKET'); },
  get s3PathPrefix() { return process.env.S3_PATH_PREFIX || 'users'; },
  get s3Region() { return req('S3_REGION'); },
  get s3AccessKeyId() { return req('S3_ACCESS_KEY_ID'); },
  get s3SecretAccessKey() { return req('S3_SECRET_ACCESS_KEY'); },
};
