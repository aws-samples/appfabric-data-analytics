#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { AuditLogsStack } = require('../lib/audit-logs-stack');
const { QuicksightStack } = require('../lib/quicksight-stack');
const { OpenSearchStack } = require('../lib/opensearch-stack');
const { AwsSolutionsChecks } = require('cdk-nag');
const { Aspects } = require('aws-cdk-lib');


const app = new cdk.App();
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))

new AuditLogsStack(app, 'AuditLogsStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

const cdkQuicksightStack = new QuicksightStack(app, 'QuicksightStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

const cdkOpenSearchStack = new OpenSearchStack(app, 'OpenSearchStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});