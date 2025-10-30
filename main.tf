terraform {terraform {

  required_providers {  required_providers {

    google = {    google = {

      source  = "hashicorp/google"      source  = "hashicorp/google"

      version = ">= 5.0.0"      version = ">= 5.0.0"

    }    }

  }  }

}}



provider "google" {provider "google" {

  project = var.gcp_project_id  project = var.gcp_project_id

  region  = var.gcp_region  region  = var.gcp_region

}}



# 1️⃣ Create a GCP Service Account (Read-only Access)# 1️⃣ Create a GCP Service Account (Read-only Access)

resource "google_service_account" "aws_readonly_sa" {resource "google_service_account" "aws_readonly_sa" {

  account_id   = "aws-readonly-sa"  account_id   = "aws-readonly-sa"

  display_name = "AWS Read-only Access Service Account"  display_name = "AWS Read-only Access Service Account"

}}



# 2️⃣ Assign Viewer Role to the Service Account# 2️⃣ Assign Viewer Role to the Service Account

resource "google_project_iam_member" "readonly_binding" {resource "google_project_iam_member" "readonly_binding" {

  project = var.gcp_project_id  project = var.gcp_project_id

  role    = "roles/viewer"  role    = "roles/viewer"

  member  = "serviceAccount:${google_service_account.aws_readonly_sa.email}"  member  = "serviceAccount:${google_service_account.aws_readonly_sa.email}"

}}



# 3️⃣ Create a Workload Identity Pool# 3️⃣ Create a Workload Identity Pool

resource "google_iam_workload_identity_pool" "aws_pool" {resource "google_iam_workload_identity_pool" "aws_pool" {

  workload_identity_pool_id = "aws-pool-mohammad14"  workload_identity_pool_id = "aws-pool-mohammad14"

  display_name              = "AWS Workload Identity Pool"  display_name              = "AWS Workload Identity Pool"

  description               = "Pool to allow AWS access to GCP"  description               = "Pool to allow AWS access to GCP"

  # Note: optionally specify location = "global" (default) etc.  # Note: optionally specify location = "global" (default) etc.

}}



# 4️⃣ Create AWS Provider for the Pool# 4️⃣ Create AWS Provider for the Pool

resource "google_iam_workload_identity_pool_provider" "aws_provider" {resource "google_iam_workload_identity_pool_provider" "aws_provider" {

  workload_identity_pool_id          = google_iam_workload_identity_pool.aws_pool.workload_identity_pool_id  workload_identity_pool_id          = google_iam_workload_identity_pool.aws_pool.workload_identity_pool_id

  workload_identity_pool_provider_id = "aws-provider"  workload_identity_pool_provider_id = "aws-provider"

  display_name                       = "AWS Provider"  display_name                       = "AWS Provider"

  description                        = "Provider for AWS account"  description                        = "Provider for AWS account"



  aws {  aws {

    account_id = var.aws_account_id    account_id = var.aws_account_id

  }  }



  attribute_mapping = {  attribute_mapping = {

    "google.subject"     = "assertion.arn"    "google.subject"     = "assertion.arn"

    "attribute.aws_role" = "assertion.arn"    "attribute.aws_role" = "assertion.arn"

  }  }



  attribute_condition = "assertion.arn.startsWith('arn:aws:sts::${var.aws_account_id}:assumed-role/${var.aws_role_name}')"  attribute_condition = "assertion.arn.startsWith('arn:aws:sts::${var.aws_account_id}:assumed-role/${var.aws_role_name}')"

}}



# 5️⃣ Allow AWS role to impersonate the GCP service account# 5️⃣ Allow AWS role to impersonate the GCP service account

resource "google_service_account_iam_binding" "aws_impersonate" {resource "google_service_account_iam_binding" "aws_impersonate" {

  service_account_id = google_service_account.aws_readonly_sa.name  service_account_id = google_service_account.aws_readonly_sa.name

  role               = "roles/iam.workloadIdentityUser"  role               = "roles/iam.workloadIdentityUser"



  members = [  members = [

    "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.aws_pool.name}/attribute.aws_role/arn:aws:sts::${var.aws_account_id}:assumed-role/${var.aws_role_name}"    "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.aws_pool.name}/attribute.aws_role/arn:aws:sts::${var.aws_account_id}:assumed-role/${var.aws_role_name}"

  ]  ]

}}



# 6️⃣ Grant service account token creator role to the workload identity pool# 6️⃣ Grant service account token creator role to the workload identity pool

resource "google_service_account_iam_binding" "token_creator" {resource "google_service_account_iam_binding" "token_creator" {

  service_account_id = google_service_account.aws_readonly_sa.name  service_account_id = google_service_account.aws_readonly_sa.name

  role               = "roles/iam.serviceAccountTokenCreator"  role               = "roles/iam.serviceAccountTokenCreator"



  members = [  members = [

    "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.aws_pool.name}/*"    "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.aws_pool.name}/*"

  ]  ]

}}



# 🔹 Outputs# 🔹 Outputs

output "workload_identity_pool_id" {output "workload_identity_pool_id" {

  value = google_iam_workload_identity_pool.aws_pool.workload_identity_pool_id  value = google_iam_workload_identity_pool.aws_pool.workload_identity_pool_id

}}



output "wif_provider_name" {output "wif_provider_name" {

  value = google_iam_workload_identity_pool_provider.aws_provider.name  value = google_iam_workload_identity_pool_provider.aws_provider.name

}}



output "gcp_service_account_email" {output "gcp_service_account_email" {

  value = google_service_account.aws_readonly_sa.email  value = google_service_account.aws_readonly_sa.email

}}









# 🔹 Variables# 🔹 Variables

variable "gcp_project_id" {variable "gcp_project_id" {

  type    = string  type    = string

  default = "my-project-mohammad-476307"  default = "my-project-mohammad-476307"

}}



variable "gcp_region" {variable "gcp_region" {

  type    = string  type    = string

  default = "us-central1"  default = "us-central1"

}}



variable "aws_account_id" {variable "aws_account_id" {

  type    = string  type    = string

  default = "926837946404"  default = "926837946404"

}}



variable "aws_role_name" {variable "aws_role_name" {

  type    = string  type    = string

  default = "gcpgcp-role-gjwu85iw"  default = "gcpgcp-role-gjwu85iw"

}}

