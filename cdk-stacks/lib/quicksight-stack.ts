import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from "constructs";
import { QuickSightTemplateConstruct } from './constructs/qs-template-construct';
import { CfnDataSource, CfnDataSet} from 'aws-cdk-lib/aws-quicksight';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { AwsCustomResource, PhysicalResourceId, AwsCustomResourcePolicy } from 'aws-cdk-lib/custom-resources';
import { PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
import * as path from 'path';
import { loadSSMParams } from '../lib/infrastructure/ssm-params-util';
const {parseS3BucketNameFromUri} = require('../lib/CommonUtility');
import {NagSuppressions} from 'cdk-nag'

export class QuicksightStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        NagSuppressions.addStackSuppressions(this, [{
          id: 'AwsSolutions-IAM4',
          reason: 'The stack creates a Custom Resource, and a Lambda handler to initiate Athena query to generate view table. The role in question is the AWS managed Lambda role'
        },{
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard is needed to allow list objects in S3 bucket'
        }])

        const ssmParams = loadSSMParams(this);
        const qsPrincipalARN = `arn:aws:quicksight:${this.region}:${this.account}:user/default/${ssmParams.quicksightAdminUsername}`;
        const athenaDatabase = ssmParams.awsGlueDatabaseName;
        const athenaTable = ssmParams.athenaTable;
        const athenaOutputURI = ssmParams.athenaQueryStorageS3URI;

        const createViewLambda = new Function(this, 'CreateView', {
          runtime: Runtime.PYTHON_3_11,
          handler: 'index.handler',
          code: Code.fromAsset('lib/lambda/createView'),
          environment: { 
            ATHENA_DATABASE: athenaDatabase.toLowerCase() || "",
            ATHENA_TABLE: athenaTable || "",
            ATHENA_OUTPUT_URI: athenaOutputURI || "",
            REGION: this.region
          },
        });

        createViewLambda.addToRolePolicy(new PolicyStatement({
          actions: ['athena:StartQueryExecution'],
          resources: ['arn:aws:athena:'+this.region+':'+this.account+':workgroup/primary']
        }));

        createViewLambda.addToRolePolicy(new PolicyStatement({
          actions: ['s3:PutObject','s3:GetBucketLocation', 's3:ListBucket'],
          resources: [
            'arn:aws:s3:::'+parseS3BucketNameFromUri(ssmParams.athenaQueryStorageS3URI)+'/*',
            'arn:aws:s3:::'+parseS3BucketNameFromUri(ssmParams.athenaQueryStorageS3URI)
          ]
        }));

        createViewLambda.addToRolePolicy(new PolicyStatement({
          actions: ['glue:GetTable','glue:CreateTable'],
          resources: [
            'arn:aws:glue:'+this.region+':'+this.account+':catalog',
            'arn:aws:glue:'+this.region+':'+this.account+':database/'+athenaDatabase.toLowerCase(),
            'arn:aws:glue:'+this.region+':'+this.account+':table/'+athenaDatabase.toLowerCase()+'/*'
          ]
        }));

        const createViewCustomResource = new AwsCustomResource(this, 'CreateViewCustomResource', {
          onCreate: {
            service: 'Lambda',
            action: 'invoke',
            parameters: {
              FunctionName: createViewLambda.functionArn,
            },
            physicalResourceId: PhysicalResourceId.of('CreateViewCustomResource'),
          },
          installLatestAwsSdk: true,
          policy: AwsCustomResourcePolicy.fromStatements([
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['lambda:InvokeFunction'],
              resources: [createViewLambda.functionArn],
            }),
          ]),
        });

        // Wait until the custom resource is complete
        this.waitUntilComplete(createViewCustomResource, qsPrincipalARN, ssmParams);
        
    }

    private waitUntilComplete(customResource: AwsCustomResource, qsPrincipalARN: string, ssmParams: any) {
      const startTime = Date.now();
      const timeout = 10000;
      const interval = setInterval(async () => {
        const response = customResource.getResponseField('Status');
  
        if (response === 'SUCCESS') {
          clearInterval(interval);
          console.log('Custom resource is complete!');
          this.completeProcess(customResource, qsPrincipalARN, ssmParams);
        } else if (response === 'FAILED') {
          clearInterval(interval);
          console.error('Custom resource failed.');
        }

        // Check if timeout reached
        if (Date.now() - startTime > timeout) {
          clearInterval(interval);
          this.completeProcess(customResource, qsPrincipalARN, ssmParams);
        }
      }, 5000); // Check every 5 seconds, adjust as needed
    }

    private completeProcess(customResource: AwsCustomResource, qsPrincipalARN: string, ssmParams: any) {
      console.log('..');

      //Datasource
      const cfnDataSource = new CfnDataSource(this, 'appfabric-analytics-athena-datasource', {
        dataSourceId: "appfabric-analysis-ds",
        name: "appfabric-analysis-ds",
        awsAccountId: this.account,
        type: "ATHENA",
        dataSourceParameters: {
          athenaParameters:{
            workGroup: "primary",
          }
        },
        permissions: [
          {
            principal: qsPrincipalARN, 
            actions: [
                "quicksight:DescribeDataSource",
                "quicksight:DescribeDataSourcePermissions",
                "quicksight:PassDataSource",
                "quicksight:UpdateDataSource",
                "quicksight:DeleteDataSource",
                "quicksight:UpdateDataSourcePermissions"  
            ]
          }
        ],
        sslProperties: {
          disableSsl: false,
        },
      })

      //Dataset
      const cfnDataSet = new CfnDataSet(this, 'appfabric-analytics-athena-dataset', {
        awsAccountId: this.account,
        name: "appfabric-analysis-datasource",
        importMode: "DIRECT_QUERY",
        dataSetId: "appfabric-analysis-datasource",
        physicalTableMap: {
          "AppFabricPhysicalTable1": {
            relationalTable: {
                dataSourceArn: cfnDataSource.attrArn,
                catalog: "AwsDataCatalog",
                schema: 'appfabricdataanalyticsdb',
                name: "view_"+ssmParams.athenaTable, 
                inputColumns: [
                  {
                    "name": "activity_id",
                    "type": "INTEGER"
                  },
                  {
                    "name": "activity_name",
                    "type": "STRING"
                  },
                  {
                    "name": "actor",
                    "type": "STRING"
                  },
                  {
                    "name": "category_name",
                    "type": "STRING"
                  },
                  {
                    "name": "category_uid",
                    "type": "INTEGER"
                  },
                  {
                    "name": "city",
                    "type": "STRING"
                  },
                  {
                    "name": "class_name",
                    "type": "STRING"
                  },
                  {
                    "name": "country",
                    "type": "STRING"
                  },
                  {
                    "name": "device",
                    "type": "STRING"
                  },
                  {
                    "name": "http_request",
                    "type": "STRING"
                  },
                  {
                    "name": "message",
                    "type": "STRING"
                  },
                  {
                    "name": "metadata",
                    "type": "STRING"
                  },
                  {
                    "name": "os_name",
                    "type": "STRING"
                  },
                  {
                    "name": "os_type",
                    "type": "STRING"
                  },
                  {
                    "name": "postal_code",
                    "type": "STRING"
                  },
                  {
                    "name": "raw_data",
                    "type": "STRING"
                  },
                  {
                    "name": "severity",
                    "type": "STRING"
                  },
                  {
                    "name": "severity_id",
                    "type": "INTEGER"
                  },
                  {
                    "name": "status",
                    "type": "STRING"
                  },
                  {
                    "name": "status_detail",
                    "type": "INTEGER"
                  },
                  {
                    "name": "status_id",
                    "type": "INTEGER"
                  },
                  {
                    "name": "time",
                    "type": "INTEGER"
                  },
                  {
                    "name": "type_name",
                    "type": "STRING"
                  },
                  {
                    "name": "type_uid",
                    "type": "INTEGER"
                  },
                  {
                    "name": "user",
                    "type": "STRING"
                  },
                  {
                    "name": "user_email_addr",
                    "type": "STRING"
                  },
                  {
                    "name": "user_name",
                    "type": "STRING"
                  },
                  {
                    "name": "user_type",
                    "type": "STRING"
                  },
                  {
                    "name": "partition_0",
                    "type": "STRING"
                  },
                  {
                    "name": "partition_1",
                    "type": "STRING"
                  },
                  {
                    "name": "partition_2",
                    "type": "STRING"
                  },
                  {
                    "name": "partition_3",
                    "type": "STRING"
                  },
                  {
                    "name": "partition_4",
                    "type": "STRING"
                  },
                  {
                    "name": "partition_5",
                    "type": "STRING"
                  },
                  {
                    "name": "partition_6",
                    "type": "STRING"
                  },
                  {
                    "name": "partition_7",
                    "type": "STRING"
                  }
                ]
            }
          }
        },
        logicalTableMap: {
          "AppFabricLogicalTable1": {
              alias: ssmParams.athenaTable,
              dataTransforms: [
                  {
                      createColumnsOperation: {
                          columns: [
                              {
                                  columnName: "timestamp",
                                  columnId: "app-fabric-ts",
                                  expression: "epochDate({time})"
                              }
                          ]
                      },
                  },
              ],
              source: {
                  physicalTableId: "AppFabricPhysicalTable1"
              }
          }
        },
        permissions: [
          {
            principal: qsPrincipalARN,
            actions: [
              "quicksight:DescribeDataSet",
              "quicksight:DescribeDataSetPermissions",
              "quicksight:PassDataSet",
              "quicksight:DescribeIngestion",
              "quicksight:ListIngestions",
            ]
          }
        ]
      })

      //Template and Analysis
      const template = (ssmParams.langOption=='ja') ? 'template-ja.json' : 'template.json';

      new QuickSightTemplateConstruct(this, 'appfabric', {
          templateDefinitionSource: path.join(__dirname, 'template-defs', template),
          dataSets: {
              "AppFabricData": cfnDataSet.attrArn,
          },
          principal: qsPrincipalARN
      });

    }

}