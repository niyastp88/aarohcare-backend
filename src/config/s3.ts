import { S3Client } from '@aws-sdk/client-s3';

const getRegion = () => process.env.AWS_REGION;
const getBucket = () => process.env.S3_BUCKET_NAME;

export const isS3Configured = () => Boolean(getRegion() && getBucket());

export const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
});

export const getS3Bucket = () => {
  const bucket = getBucket();
  if (!bucket) {
    throw new Error('S3_BUCKET_NAME is not configured');
  }
  return bucket;
};

export const getS3PublicUrl = (key: string) => {
  const configuredBase = process.env.S3_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configuredBase) {
    return `${configuredBase}/${key}`;
  }

  const region = getRegion();
  const bucket = getBucket();
  if (!region || !bucket) {
    throw new Error('AWS_REGION and S3_BUCKET_NAME are required');
  }

  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
};
