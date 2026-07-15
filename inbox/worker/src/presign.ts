// Presigned R2-URLs via het S3-protocol (aws4fetch). De telefoon PUT en de
// desktop GET rechtstreeks naar R2, buiten de Worker om (§5.1, §5.3).
//
// Valkuil (§6.5): we signen ZONDER `content-type` in de SignedHeaders. De client
// mag 'm dan vrij meesturen zonder een 403 door header-mismatch te riskeren.

import { AwsClient } from 'aws4fetch'
import type { Env } from './config'

const DEFAULT_EXPIRES_SEC = 900 // 15 min (§5.5)

function client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  })
}

/** Het S3-object-URL. De host krijgt een jurisdictie-infix (`.eu.`) als
 * `R2_JURISDICTION` gezet is — een EU-bucket is anders niet bereikbaar. */
function s3ObjectUrl(env: Env, key: string): string {
  const jur = env.R2_JURISDICTION?.trim()
  const host = `${env.R2_ACCOUNT_ID}${jur ? `.${jur}` : ''}.r2.cloudflarestorage.com`
  const bucket = env.R2_BUCKET?.trim() || 'memorylane'
  return `https://${host}/${bucket}/${key}`
}

async function presign(
  env: Env,
  key: string,
  method: 'PUT' | 'GET',
  expiresSec: number,
): Promise<string> {
  const url = new URL(s3ObjectUrl(env, key))
  url.searchParams.set('X-Amz-Expires', String(expiresSec))
  const signed = await client(env).sign(url.toString(), {
    method,
    aws: { signQuery: true },
  })
  return signed.url
}

export const presignPut = (env: Env, key: string, expiresSec = DEFAULT_EXPIRES_SEC): Promise<string> =>
  presign(env, key, 'PUT', expiresSec)

export const presignGet = (env: Env, key: string, expiresSec = DEFAULT_EXPIRES_SEC): Promise<string> =>
  presign(env, key, 'GET', expiresSec)
