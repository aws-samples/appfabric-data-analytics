from crhelper import CfnResource
from opensearchpy import AWSV4SignerAuth
import string
import os
import json
import boto3
import botocore
import requests
import time

__version__ = '1.00.0'

helper = CfnResource()

MAX_RETRIES = 10

def import_data(event, _):
    print("import_data start")

    REGION = os.environ['AWS_REGION']
    ENDPOINT = os.environ['OSS_ENDPOINT']
    AOS_SERVICE = 'aoss'

    credentials = boto3.Session().get_credentials()
    awsauth = AWSV4SignerAuth(credentials, REGION, AOS_SERVICE)

    url = (f'{ENDPOINT}/_dashboards/api/saved_objects/_import?overwrite=true')
    headers = {'osd-xsrf': 'true'}
    for attempt in range(1, MAX_RETRIES + 1):
        print(f"Import Attempt {attempt}")
        if os.path.exists('dashboard.ndjson'):
            with open('dashboard.ndjson', 'rb') as fd:
                response = requests.post(
                    url=url, 
                    files={'file': fd},
                    headers=headers, 
                    auth=awsauth)
                # Check if the request was successful
                if response.status_code == 200:
                    print(f"Import Request successful (Attempt {attempt}): {response.status_code}")
                    return {"ImportOutputAttribute": "successful"}
                else:
                    print(f"Import Request failed (Attempt {attempt}): {response.status_code}")
                    print(f"Import Response text: {response.text}")
                    time.sleep(attempt)
        else:
            print('dashboard.ndjson is not contained')
            raise ValueError("dashboard.ndjson not found")

    # If all attempts fail, handle the failure
    print("All import requests failed")
    raise ValueError(f"All import request attemps ({attempt}) failed - {response.text}")
    return {"ImportOutputAttribute": "failed"}

def create_index(event, _):
    print("create_index start")

    # Define the index template payload
    index_template_name = "appfabric_template"
    index_template = {
        "index_patterns": ["appfabric"],
        "template": {
            "mappings": {
                "properties": {
                    "time": {
                        "type": "date"
                    },
                    "device": {
                        "properties": {
                            "ip": {
                                "type": "ip",
                                "ignore_malformed": "true"
                            }
                        }
                    },
                    "activity_id": {
                        "type": "long"
                    },
                    "category_uid": {
                        "type": "long"
                    },
                    "class_uid": {
                        "type": "long"
                    },
                    "type_uid": {
                        "type": "long"
                    }
                }
            }
        }
    }

    REGION = os.environ['AWS_REGION']
    ENDPOINT = os.environ['OSS_ENDPOINT']
    AOS_SERVICE = 'aoss'
    url = (f'{ENDPOINT}/_dashboards/api/console/proxy?path=_index_template/{index_template_name}&method=PUT')
    headers = {'osd-xsrf': 'true'}

    credentials = boto3.Session().get_credentials()
    awsauth = AWSV4SignerAuth(credentials, REGION, AOS_SERVICE)
    
    for attempt in range(1, MAX_RETRIES + 1):
        print(f"Index Attempt {attempt}")
        response = requests.post(
                    url=url, 
                    headers=headers,
                    json=index_template,
                    auth=awsauth)
        # Check if the request was successful
        if response.status_code == 200:
            print(f"Index Request successful (Attempt {attempt}): {response.status_code}")
            return {"IndexOutputAttribute": "successful"}
        else:
            print(f"Index Request failed (Attempt {attempt}): {response.status_code}")
            print(f"Response text: {response.text}")

    # If all attempts fail, handle the failure
    print("All index requests failed")
    return {"IndexOutputAttribute": "failed"}
    

@helper.create
def main(event, _):
    import_data(event, _)
    create_index(event, _)


@helper.update
def main(event, _):
    import_data(event, _)
    create_index(event, _)

@helper.delete
def no_op(_, __):
    pass

def handler(event, context):
    print("context: " + str(context))
    helper(event, context)