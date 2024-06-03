import {Stack, StackProps, CfnOutput, Duration, RemovalPolicy, Aws} from 'aws-cdk-lib';
import {Construct} from "constructs";
import {PolicyDocument, PolicyStatement, Role, ServicePrincipal, Effect, AccountPrincipal} from "aws-cdk-lib/aws-iam";
import {Function, Runtime, Code} from "aws-cdk-lib/aws-lambda";
import {CfnSecurityPolicy, CfnCollection, CfnAccessPolicy} from "aws-cdk-lib/aws-opensearchserverless";
import {CfnCustomResource} from 'aws-cdk-lib/aws-cloudformation';
import {CfnDeliveryStream} from 'aws-cdk-lib/aws-kinesisfirehose';
import {Bucket} from 'aws-cdk-lib/aws-s3';
import {NagSuppressions} from 'cdk-nag'
import path = require('path');
import { loadSSMParams } from '../lib/infrastructure/ssm-params-util';


const configParams = require('../config.params.json');
const {parseS3BucketNameFromUri} = require('../lib/CommonUtility');

export class OpenSearchStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        //Nag suppressions at stack level all apply to a Custom Resource that is deployed under the hood
        NagSuppressions.addStackSuppressions(this, [{
            id: 'AwsSolutions-S1',
            reason: 'Server access log is disabled as only failed ingestion are being kept'
        }, {
            id: 'AwsSolutions-IAM5',
            reason: 'The wildcard s3:* is needed to grant permissions to all the objects in the bucket. This nag also applied to the Lambda handler in the Customer Resources deployed under the hood'
        }])

        const ssmParams = loadSSMParams(this);
        const langOption = ssmParams.langOption;

        ////////////////////////////////////////////////////////
        // setup OpenSearch Serverless security policy
        ////////////////////////////////////////////////////////

        const collectionName = 'appfabric-cdk'

        const networkSecurityJSON = JSON.stringify([{
            Rules: [
                {
                  Resource: [
                    `collection/${collectionName}`
                  ],
                  ResourceType: "dashboard"
                },
                {
                  Resource: [
                    `collection/${collectionName}`
                  ],
                  ResourceType: "collection"
                }
            ],
            AllowFromPublic: true
        }], null, 2);

        const networkSecurityPolicy = new CfnSecurityPolicy(this, 'NetworkSecurityPolicy', {
            policy: networkSecurityJSON, 
            name: `${collectionName}-network`,
            description: "Created By CDK AppFabric Solution. DO NOT EDIT",
            type: "network"
        })

        const encryptionSecurityJSON = JSON.stringify({
            Rules: [
              {
                Resource: [
                  `collection/${collectionName}`
                ],
                ResourceType: "collection"
              }
            ],
            AWSOwnedKey: true
        }, null, 2);

        const encryptionSecurityPolicy = new CfnSecurityPolicy(this, 'EncryptionSecurityPolicy', {
            policy: encryptionSecurityJSON,
            name: `${collectionName}-security`,
            type: "encryption"
        })

        ////////////////////////////////////////////////////////
        // create OpenSearch Serverless collection
        ////////////////////////////////////////////////////////

        const ossCollection = new CfnCollection(this, 'OpenSearchServerless', {
            name: collectionName,
            description: 'Created By CDK AppFabric Solution.',
            type: 'TIMESERIES',
        });
        ossCollection.addDependency(networkSecurityPolicy);
        ossCollection.addDependency(encryptionSecurityPolicy);

        const userAcceesPolicy = JSON.stringify([{
            Rules: [
                {
                    Resource: [
                        `collection/${collectionName}`
                    ],
                    Permission: [
                        "aoss:CreateCollectionItems",
                        "aoss:DeleteCollectionItems",
                        "aoss:UpdateCollectionItems",
                        "aoss:DescribeCollectionItems"
                    ],
                    ResourceType: "collection"
                },
                {
                    Resource: [
                        `index/${collectionName}/*`
                    ],
                    Permission: [
                        "aoss:CreateIndex",
                        "aoss:DeleteIndex",
                        "aoss:UpdateIndex",
                        "aoss:DescribeIndex",
                        "aoss:ReadDocument",
                        "aoss:WriteDocument"
                    ],
                    ResourceType: "index"
                }
            ],
            Principal: [
                `arn:aws:iam::${Aws.ACCOUNT_ID}:root`
            ],
            Description: "data-access-rule"
        }], null, 2);

        const userAccessPolicy = new CfnAccessPolicy(this, 'UserAccessPolicy', {
            name: `${collectionName}-user-policy`,
            description: "Created By CDK AppFabric Solution. DO NOT EDIT",
            policy: userAcceesPolicy,
            type: "data"
        });

        new CfnOutput(this, 'OpenSearchEndpoint', {
            value: ossCollection.attrCollectionEndpoint,
            exportName: `${this.stackName}-OpenSearchEndpoint`
        });
        new CfnOutput(this, 'DashboardsURL', {
            value: ossCollection.attrDashboardEndpoint,
            exportName: `${this.stackName}-DashboardsURL`
        });

        ////////////////////////////////////////////////////////
        // setup policy for Lambda
        ////////////////////////////////////////////////////////

        const ossDeploymentPolicy = new PolicyDocument({
            statements: [
                new PolicyStatement({
                    actions: [
                        "aoss:APIAccessAll",
                        "aoss:DashboardsAccessAll",
                        "aoss:BatchGetCollection",
                        "aoss:BatchGetVpcEndpoint",
                        "aoss:CreateCollection",
                        "aoss:CreateSecurityPolicy",
                        "aoss:GetSecurityPolicy",
                        "aoss:UpdateSecurityPolicy",
                    ],
                    resources: ["*"]
                }),
                new PolicyStatement({
                    actions: [
                        "logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents",
                    ],
                    resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`,], 
                })
            ]
        });

        // Define a custom IAM policy for your Lambda function
        const lambdaPolicy = new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
            ],
            resources: ["*"], // Adjust the resource scope as per your requirements
        });

        
        const ossDeployRoleForLambda = new Role(this, 'ossDeployRoleForLambda', {
            roleName: 'oss-deploy-role-for-lambda',
            inlinePolicies: {
                'opensearch_deployment': ossDeploymentPolicy,
            },
            assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        });
        ossDeployRoleForLambda.addToPolicy(lambdaPolicy);

        ////////////////////////////////////////////////////////
        // create Lambda that imports dashboard template and create index
        ////////////////////////////////////////////////////////

        const lambdaDeploy = new Function(this, 'LambdaDeploy', {
            description: "Created By CDK AppFabric Solution. DO NOT EDIT",
            runtime: Runtime.PYTHON_3_11,
            code: Code.fromAsset(path.join(__dirname, 'lambda/deploy_es'), {
                bundling: {
                    image: Runtime.PYTHON_3_11.bundlingImage,
                    command: [
                        'bash', '-c',
                        'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output && chmod -R 755 /asset-output',
                    ],
                },
            }),
            environment: {
                OSS_ENDPOINT: ossCollection.attrCollectionEndpoint,
                LANG_OPTION: langOption
            },
            role: ossDeployRoleForLambda,
            handler: 'index.handler',
            memorySize: 256,
            reservedConcurrentExecutions: 1,
            timeout: Duration.minutes(5),
        });
        lambdaDeploy.node.addDependency(ossDeployRoleForLambda);
        lambdaDeploy.node.addDependency(ossCollection);

        const dataAcceesPolicy = JSON.stringify([{
            Description: "Created By CDK AppFabric Solution. DO NOT EDIT",
            Rules: [
                {
                    Resource: [
                        `index/${collectionName}/log-*`,
                        `index/${collectionName}/metrics-*`,
                        `index/${collectionName}/*`
                    ],
                    Permission: [
                        "aoss:*"
                    ],
                    ResourceType: "index"
                },
                {
                    Resource: [
                        `collection/${collectionName}`
                    ],
                    Permission: [
                        "aoss:CreateCollectionItems",
                        "aoss:DeleteCollectionItems",
                        "aoss:UpdateCollectionItems",
                        "aoss:DescribeCollectionItems"
                    ],
                    ResourceType: "collection"
                }
            ],
            Principal: [
                lambdaDeploy.role?.roleArn
            ]
        }], null, 2);

        const lambdaAccessPolicy = new CfnAccessPolicy(this, 'LambdaAccessPolicy', {
            name: `${collectionName}-lambda-policy`,
            description: "Created By CDK AppFabric Solution. DO NOT EDIT",
            policy: dataAcceesPolicy,
            type: "data"
        });

        ////////////////////////////////////////////////////////
        // trigger Lambda function
        ////////////////////////////////////////////////////////

        const lambda_trigger = new CfnCustomResource(this, 'LambdaTrigger', {
            serviceToken: lambdaDeploy.functionArn,
        });
        lambda_trigger.node.addDependency(lambdaDeploy);
        lambda_trigger.node.addDependency(lambdaAccessPolicy);

        ////////////////////////////////////////////////////////
        // setup Firehose as data ingestion to OpenSearch Serverless
        ////////////////////////////////////////////////////////

        // Create an S3 bucket for Firehose failed record 
        const bucket = new Bucket(this, 'FirehoseErrorBucket', {
            removalPolicy: RemovalPolicy.DESTROY, 
            autoDeleteObjects: true, 
            versioned: true, 
            enforceSSL: true,
        });

        const deliveryStreamPolicy = new PolicyDocument({
            statements:[
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        "s3:AbortMultipartUpload",
                        "s3:GetBucketLocation",
                        "s3:GetObject",
                        "s3:ListBucket",
                        "s3:ListBucketMultipartUploads",
                        "s3:PutObject"
                    ],
                    resources: [
                        bucket.bucketArn,
                        `${bucket.bucketArn}/*`
                    ],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["aoss:APIAccessAll"],
                    resources: [ossCollection.attrArn],
                })
            ]
        });

        // Create an IAM role
        const firehoseRole = new Role(this, 'FirehoseRole', {
            assumedBy: new ServicePrincipal('firehose.amazonaws.com'),
            inlinePolicies: {
                'policy': deliveryStreamPolicy
            }
        });
        
        ////////////////////////////////////////////////////////
        // create a Kinesis Data Firehose delivery stream
        ////////////////////////////////////////////////////////

        const firehoseStream = new CfnDeliveryStream(this, 'FirehoseStream', {
            deliveryStreamType: 'DirectPut',
            deliveryStreamEncryptionConfigurationInput: {
                keyType: "AWS_OWNED_CMK"
            },
            amazonOpenSearchServerlessDestinationConfiguration: {
                indexName: 'appfabric',
                collectionEndpoint: ossCollection.attrCollectionEndpoint,
                roleArn: firehoseRole.roleArn,
                s3Configuration: {
                    bucketArn: bucket.bucketArn,
                    bufferingHints: {
                        intervalInSeconds: 60,
                        sizeInMBs: 5
                    },
                    roleArn: firehoseRole.roleArn,
                    cloudWatchLoggingOptions: {
                        enabled: true, 
                        logGroupName: 'FirehoseLogs', 
                        logStreamName: 'FirehoseStreamLogs' 
                    }
                }
            }
        });

        const firehosePolicy = JSON.stringify([{
            Description: "Created By CDK AppFabric Solution. DO NOT EDIT",
            Rules: [
                {
                    Resource: [
                        `index/${collectionName}/appfabric`
                    ],
                    Permission: [
                        "aoss:CreateIndex",
                        "aoss:DeleteIndex",
                        "aoss:UpdateIndex",
                        "aoss:DescribeIndex",
                        "aoss:ReadDocument",
                        "aoss:WriteDocument"
                    ],
                    ResourceType: "index"
                }
            ],
            Principal: [
                firehoseRole.roleArn
            ]
        }], null, 2);


        new CfnOutput(this, 'FirehoseName', {
            value: firehoseStream.ref,
            exportName: `${this.stackName}-FirehoseName`
        });
        new CfnOutput(this, 'FirehoseArn', {
            value: firehoseStream.attrArn,
            exportName: `${this.stackName}-FirehoseArn`
        });
    }
}