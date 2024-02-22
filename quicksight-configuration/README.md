# QuickSight Configuration

## New QuickSight Setup
> NOTE: The following will configure a new QuickSight account that will incur additional charges.  The following will also grant access for QuickSight to access data stored in Amazon S3.  **Please consult with your AWS Admins and Information Security departments if you don't have a full understanding of the choices below.**

1. Navigate to QuickSight in the Console:
![Search for QuickSight in Console](qs0.png)

2. Click `Signup for QuickSight`
![Sign Up for Quicksight](qs1.png)

3. Select the plan that applies to you. Please note the additional costs.
![Select Plan](qs2.png)

4. Select the appropriate authentication type and enter a username and admin email address.
![Authentication Type](qs3.png)

5. Select Amazon Athena and Amazon S3
![Service Configuration](qs4.png)

6. Configure the Amazon S3 Buckets for AppFabric Data
- Select the Bucket where AppFabric is storing log data
- You will also need to select a S3 Bucket for Athena to store query results.
![S3 Buckets](qs5.png)

## Adding S3 and Athena to QuickSight Services
> If QuickSight has already been setup, please make sure Athena and S3 are added to the services available to QuickSight:

1. Hover over the icon at the top-right and navigate to `Manage QuickSight`
![Manage Quicksight](qs11.png)

2. Select: `Security & Permissions`
![Security and Permissions](qs22.png)

3. Select Amazon Athena and Amazon S3
![Service Configuration](qs4.png)

4. Configure the Amazon S3 Buckets for AppFabric Data
- Select the Bucket where AppFabric is storing log data
- You will also need to select a S3 Bucket for Athena to store query results.
![S3 Buckets](qs5.png)