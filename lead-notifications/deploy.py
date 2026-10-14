#!/usr/bin/env python3
"""Build and deploy only the isolated DSB notifications stack (never serverless.yml)."""
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

BASE = Path(__file__).resolve().parent
REGION = 'us-east-1'


def aws(*args, capture=False):
    return subprocess.run(['aws', *args, '--region', REGION], check=True,
                          capture_output=capture, text=True)


def main():
    subprocess.run(['npm', 'ci', '--no-audit', '--no-fund'], cwd=BASE, check=True)
    subprocess.run(['npm', 'test'], cwd=BASE, check=True)
    subprocess.run(['npm', 'run', 'build'], cwd=BASE, check=True)
    account = json.loads(aws('sts', 'get-caller-identity', capture=True).stdout)['Account']
    bucket = f'yapn-dsb-lead-artifacts-{account}'
    exists = subprocess.run(['aws', 's3api', 'head-bucket', '--bucket', bucket], capture_output=True)
    if exists.returncode:
        aws('s3api', 'create-bucket', '--bucket', bucket)
    aws('s3api', 'put-public-access-block', '--bucket', bucket,
        '--public-access-block-configuration', json.dumps(dict(
            BlockPublicAcls=True, IgnorePublicAcls=True,
            BlockPublicPolicy=True, RestrictPublicBuckets=True)))
    aws('s3api', 'put-bucket-encryption', '--bucket', bucket,
        '--server-side-encryption-configuration', json.dumps({'Rules': [{
            'ApplyServerSideEncryptionByDefault': {'SSEAlgorithm': 'AES256'}}]}))
    aws('s3api', 'put-bucket-versioning', '--bucket', bucket,
        '--versioning-configuration', 'Status=Enabled')
    archive = BASE / 'build/function.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
        bundle.write(BASE / 'build/index.js', 'index.js')
    key = f'function-{hashlib.sha256(archive.read_bytes()).hexdigest()[:20]}.zip'
    aws('s3', 'cp', str(archive), f's3://{bucket}/{key}', '--only-show-errors')
    topics = json.loads(aws('sns', 'list-topics', capture=True).stdout)['Topics']
    topic = next((t['TopicArn'] for t in topics if t['TopicArn'].endswith(':yapn-order-processor-alerts-dev')), '')
    aws('cloudformation', 'deploy', '--stack-name', 'yapn-dsb-lead-notifications',
        '--template-file', str(BASE / 'template.json'), '--parameter-overrides',
        f'CodeBucket={bucket}', f'CodeKey={key}', f'AlarmTopicArn={topic}',
        '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset')
    print(aws('cloudformation', 'describe-stacks', '--stack-name',
              'yapn-dsb-lead-notifications', '--query', 'Stacks[0].Outputs', capture=True).stdout)


if __name__ == '__main__':
    main()
