import os
import boto3

CRAWLER_NAME = os.environ['CRAWLER_NAME']

def handler(event, context):
    glue_client = boto3.client('glue')
    crawler_name = CRAWLER_NAME 

    try:
        response = glue_client.start_crawler(Name=crawler_name)
        print(f'Successfully started crawler: {crawler_name}')
        return {
            'statusCode': 200,
            'body': f'Successfully started crawler: {crawler_name}'
        }
    except glue_client.exceptions.CrawlerRunningException:
        print(f'Crawler {crawler_name} is already running or starting')
        return {
            'statusCode': 400,
            'body': f'Crawler {crawler_name} is already running or starting'
        }
    except glue_client.exceptions.EntityNotFoundException:
        print(f'Crawler {crawler_name} not found')
        return {
            'statusCode': 404,
            'body': f'Crawler {crawler_name} not found'
        }
    except Exception as e:
        print(f'Error starting crawler: {str(e)}')
        return {
            'statusCode': 500,
            'body': f'Error starting crawler: {str(e)}'
        }