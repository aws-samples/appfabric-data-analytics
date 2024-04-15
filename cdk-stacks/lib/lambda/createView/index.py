import boto3
import os

ATHENA_TABLE = os.environ['ATHENA_TABLE']
ATHENA_OUTPUT_URI = os.environ['ATHENA_OUTPUT_URI']
REGION = os.environ['REGION']

def handler(event, context):
    # Initialize AWS SDK clients
    athena_client = boto3.client('athena', region_name=REGION)

    # Define the SQL query to create or replace the view
    query = f"""
        CREATE OR REPLACE VIEW "appfabricdataanalyticsdb"."view_{ATHENA_TABLE}" AS
        SELECT
            activity_id,
            activity_name,
            actor,
            category_name,
            category_uid,
            class_name,
            device,
            http_request,
            metadata,
            raw_data,
            severity_id,
            status,
            status_id,
            time,
            type_name,
            type_uid,
            user,
            auth_protocol,
            auth_protocol_id,
            message,
            severity,
            status_detail,
            partition_0,
            partition_1,
            partition_2,
            partition_3,
            partition_4,
            partition_5,
            partition_6,
            partition_7,
            actor.user.email_addr AS user_email_addr,
            actor.user.name AS user_name,
            actor.user.type AS user_type,
            device.ip AS device_ip,
            device.type AS device_type,
            device.location.city,
            device.location.country,
            device.location.postal_code,
            device.os.name AS os_name,
            device.os.type AS os_type
        FROM "appfabricdataanalyticsdb"."{ATHENA_TABLE}"
    """ 
    #     CASE
    #     WHEN LENGTH(CAST(time AS VARCHAR)) >= 13 THEN CAST(from_unixtime(time / 1000) AS TIMESTAMP)
    #     ELSE CAST(from_unixtime(time) AS TIMESTAMP)
    # END AS timestamp,

    # Start the query execution
    response = athena_client.start_query_execution(
        QueryString=query,
        ResultConfiguration={
            'OutputLocation': ATHENA_OUTPUT_URI
        }
    )

    # Return the Query Execution ID
    return response['QueryExecutionId']
