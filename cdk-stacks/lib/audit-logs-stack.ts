import {Duration, RemovalPolicy, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from "constructs";
import * as glue from "aws-cdk-lib/aws-glue";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as iam from "aws-cdk-lib/aws-iam";
import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import * as kms from "aws-cdk-lib/aws-kms";
import {NagSuppressions} from 'cdk-nag'

import {loadSSMParams} from '../lib/infrastructure/ssm-params-util';

const configParams = require('../config.params.json');
const {parseS3BucketNameFromUri} = require('../lib/CommonUtility');

export class AuditLogsStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        //Nag suppressions at stack level all apply to a Custom Resource that is deployed under the hood
        NagSuppressions.addStackSuppressions(this, [{
            id: 'AwsSolutions-IAM4',
            reason: 'The S3 event notification creates a Custom Resource, and a Lambda handler under the hood to provision bucket notifications. The role in question is the AWS managed Lambda role'
        }, {
            id: 'AwsSolutions-IAM5',
            reason: 'The wildcard s3:* is needed to grant permissions to all the objects in the bucket. This nag also applied to the Lambda handler in the Customer Resources deployed under the hood'
        },])

        const ssmParams = loadSSMParams(this);

        //Dead letter queue
        const eventProcessingDLQ = new sqs.Queue(this, 'EventProcessingDLQ', {
            queueName: `${configParams.CdkAppName}-EventProcessingDLQ`,
            retentionPeriod: Duration.days(14),
            visibilityTimeout: Duration.seconds(300),
            enforceSSL: true,
        });
        NagSuppressions.addResourceSuppressions(eventProcessingDLQ, [{
            id: 'AwsSolutions-SQS3', reason: 'This is the dead letter queue.'
        },]);

        //Create SQS Queue
        const eventProcessingQueue = new sqs.Queue(this, 'EventProcessingQueue', {
            queueName: `${configParams.CdkAppName}-EventProcessingQueue`, deadLetterQueue: {
                maxReceiveCount: 3, queue: eventProcessingDLQ,
            }, enforceSSL: true
        });

        //Create SQS IAM policy
        eventProcessingQueue.addToResourcePolicy(new iam.PolicyStatement({
            principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
            actions: ['SQS:SendMessage'],
            resources: [eventProcessingQueue.queueArn],
            conditions: {
                ArnEquals: {"aws:SourceArn": `arn:aws:s3:::${ssmParams.appFabricDataSourceS3BucketName}`}
            }
        }))

        //Create S3 Event notification
        //Use Lazy values to encode bucket name as a token and defer the calculation to synthesis time
        const appFabricDataSourceBucket = s3.Bucket.fromBucketName(this, 'AppFabricDataSourceBucket', cdk.Lazy.string({produce: () => ssmParams.appFabricDataSourceS3BucketName}));
        appFabricDataSourceBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(eventProcessingQueue))


        //Create Glue Database
        const appFabricDataAnalyticsDB = new glue.CfnDatabase(this, 'AppFabricDataAnalyticsDB', {
            catalogId: this.account, databaseInput: {
                name: ssmParams.awsGlueDatabaseName.toLowerCase(),
                description: 'AWS Glue Database to hold table for Amazon AppFabric Data Analytics'
            },
        });

        //Create Glue role
        const glueCrawlerRole = new iam.Role(this, 'GlueCrawlerRole', {
            roleName: 'GlueCrawlerRole',
            description: 'Role for Glue services to access S3',
            assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
        });

        // The role is created with AWSGlueServiceRole policy and authorize all actions on S3.
        // If you would like to scope down the permission you should create a new role with a scoped down policy
        glueCrawlerRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'))

        // Attach an S3 policy to the IAM Role
        const s3Policy = new iam.Policy(this, 'S3Policy', {
            statements: [new iam.PolicyStatement({
                actions: ['s3:GetObject', 's3:ListBucket', 's3:PutObject'],
                resources: [`arn:aws:s3:::${ssmParams.appFabricDataSourceS3BucketName}`, `arn:aws:s3:::${ssmParams.appFabricDataSourceS3BucketName}/*`]
            })]
        });

        // Attach an SQS policy to the IAM Role
        const sqsPolicy = new iam.Policy(this, 'SQSPolicy', {
            statements: [new iam.PolicyStatement({
                actions: ["sqs:DeleteMessage", "sqs:GetQueueUrl", "sqs:ListDeadLetterSourceQueues", "sqs:ReceiveMessage", "sqs:GetQueueAttributes", "sqs:ListQueueTags", "sqs:SetQueueAttributes", "sqs:PurgeQueue"],
                resources: [eventProcessingQueue.queueArn, eventProcessingDLQ.queueArn]
            })]
        });

        // Create an IAM policy allowing logs:AssociateKmsKey action for CloudWatch Logs log group
        const logsAssociateKmsPolicy = new iam.Policy(this, 'KmsPolicy', {
            statements: [new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:AssociateKmsKey'],
                resources: [
                    `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws-glue/crawlers-role/*`
                ],
            })]
        });

        glueCrawlerRole.attachInlinePolicy(s3Policy);
        glueCrawlerRole.attachInlinePolicy(sqsPolicy);
        glueCrawlerRole.attachInlinePolicy(logsAssociateKmsPolicy);

        //Create Glue schedule object
        const scheduleProperty: glue.CfnCrawler.ScheduleProperty = {
            scheduleExpression: 'cron(15 12 * * ? *)',
        };

        const cloudWatchKmsKey = new kms.Key(this, "CloudwatchEncryptionKey", {
            description: "Encrypts cloudwatch logs for tag-inventory solution",
            removalPolicy: RemovalPolicy.DESTROY,
            enableKeyRotation: true,
            policy: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  principals: [new iam.AccountPrincipal(this.account)],
                  actions: ["kms:*"],
                  resources: ["*"],
                }),
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: [
                    "kms:Encrypt*",
                    "kms:Decrypt*",
                    "kms:ReEncrypt*",
                    "kms:GenerateDataKey*",
                    "kms:Describe*",
                  ],
                  principals: [
                    new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
                  ],
                  resources: ["*"],
                }),
              ],
            }),
        });
 
        //Create crawler security configuration
        const glueSecurityConfig = new glue.CfnSecurityConfiguration(this, 'GlueCrawlerSecurityConfiguration', {
            name: 'GlueCrawlerSecurityConfiguration',
            encryptionConfiguration: {
                cloudWatchEncryption: {
                    cloudWatchEncryptionMode: 'SSE-KMS',
                    kmsKeyArn: cloudWatchKmsKey.keyArn,
                }
            }
        });

        //Create Glue crawler
        const glueCrawler = new glue.CfnCrawler(this, 'GlueCrawler', {
            name: 'AppFabricCrawler',
            role: glueCrawlerRole.roleArn,
            databaseName: ssmParams.awsGlueDatabaseName.toLowerCase(),
            targets: {
                s3Targets: [{
                    dlqEventQueueArn: eventProcessingDLQ.queueArn,
                    eventQueueArn: eventProcessingQueue.queueArn,
                    path: ssmParams.appFabricDataSourceS3URI
                }],
            },
            recrawlPolicy: {
                recrawlBehavior: 'CRAWL_EVENT_MODE',
            },
            crawlerSecurityConfiguration: glueSecurityConfig.name,
            schedule: scheduleProperty,
            configuration: '{"Version": 1.0, "CrawlerOutput": {"Partitions": {"AddOrUpdateBehavior": "InheritFromTable"}}}',
        })        
        // Add dependency to ensure Glue Crawler is created after the policies are attached to the role
        glueCrawler.node.addDependency(sqsPolicy);
        glueCrawler.node.addDependency(glueSecurityConfig);


        // Create IAM Role for Lambda
        const startCrawlerLambdaRole = new iam.Role(this, 'startCrawlerLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            inlinePolicies: {
                ['firehosePolicy']: new iam.PolicyDocument({
                statements: [
                    new iam.PolicyStatement({
                    actions: ['glue:StartCrawler'],
                    resources: ['*'],
                    }),
                ],
                }),
            },
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                'service-role/AWSLambdaBasicExecutionRole',
                ),
            ],
        });

        // Create Lambda function to start Glue Crawler. The Glue Crawler is created in the stack above. 
        const startCrawlerLambda = new lambda.Function(this, 'StartCrawlerLambda', {
            code: lambda.Code.fromAsset('lib/lambda/startCrawler'),
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            memorySize: 128,
            timeout: cdk.Duration.minutes(15),
            role: startCrawlerLambdaRole,
            environment: { 
                CRAWLER_NAME: glueCrawler.name || "",
            },
        });

        // Define the custom resource to invoke the Lambda function
        const customResource = new cr.AwsCustomResource(this, 'GlueCrawlerCustomResource', {
            onCreate: {
            service: 'Lambda',
            action: 'invoke',
            physicalResourceId: cr.PhysicalResourceId.of('StartCrawlerLambda'),
            parameters: {
                FunctionName: startCrawlerLambda.functionName,
                InvocationType: 'RequestResponse',
                Payload: '{}',
            },
            region: this.region, 
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['lambda:InvokeFunction'],
                    resources: [startCrawlerLambda.functionArn],
                    effect: iam.Effect.ALLOW,
                }),
            ]),
            installLatestAwsSdk: false,
        });
        customResource.node.addDependency(glueCrawler);

    }
}