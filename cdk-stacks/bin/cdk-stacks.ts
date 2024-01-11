#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { AuditLogsStack } = require('../lib/audit-logs-stack');
const { AwsSolutionsChecks } = require('cdk-nag');
const { Aspects } = require('aws-cdk-lib');

const app = new cdk.App();
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))

new AuditLogsStack(app, 'AuditLogsStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
