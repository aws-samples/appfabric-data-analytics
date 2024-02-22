import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from "constructs";
import { QuickSightTemplateConstruct } from './constructs/qs-template-construct';
import { CfnDataSource, CfnDataSet} from 'aws-cdk-lib/aws-quicksight';
import * as path from 'path';
import { loadSSMParams } from '../lib/infrastructure/ssm-params-util';
import { AthenaWorkgroupEncryptedQueryResults } from 'cdk-nag/lib/rules/athena';
const {parseS3BucketNameFromUri} = require('../lib/CommonUtility');

export class QuicksightStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        const ssmParams = loadSSMParams(this);
        const qsPrincipalARN = `arn:aws:quicksight:${this.region}:${this.account}:user/default/${ssmParams.quicksightAdminUsername}`

        //Datasource
        const cfnDataSource = new CfnDataSource(this, 'appfabric-analytics-athena-datasource', {
            name: "appfabric-analysis-ds",
            type: "ATHENA",
            awsAccountId: this.account,
            dataSourceId: "appfabric-analysis-ds",
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
                ]
              }
            ],
            sslProperties: {
              disableSsl: false,
            },
          })

        //Dataset
        const cfnDataSet = new CfnDataSet(this, 'appfabric-analytics-athena-dataset', {
            importMode: "SPICE",
            name: "appfabric-analysis-datasource",
            dataSetId: "appfabric-analysis-datasource",
            awsAccountId: this.account,
            physicalTableMap: {
              "AppFabricPhysicalTable1": {
                  relationalTable: {
                      dataSourceArn: cfnDataSource.attrArn,
                      catalog: "AwsDataCatalog",
                      schema: ssmParams.awsGlueDatabaseName.toLowerCase(),
                      name: parseS3BucketNameFromUri(ssmParams.appFabricDataSourceS3URI).toLowerCase().replaceAll('-','_'), //https://stackoverflow.com/a/50723148,
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
                            "name": "class_name",
                            "type": "STRING"
                          },
                          {
                            "name": "class_uid",
                            "type": "INTEGER"
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
                            "name": "is_mfa",
                            "type": "BOOLEAN"
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
                            "name": "unmapped",
                            "type": "STRING"
                          },
                          {
                            "name": "user",
                            "type": "STRING"
                          },
                          {
                            "name": "web_resources",
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
                  alias: ssmParams.awsGlueDatabaseName.toLowerCase(),
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
        new QuickSightTemplateConstruct(this, 'appfabric', {
            templateDefinitionSource: path.join(__dirname, 'template-defs', 'template.json'),
            dataSets: {
                "AppFabricData": cfnDataSet.attrArn,
            },
            principal: qsPrincipalARN
        });
        
    }
}