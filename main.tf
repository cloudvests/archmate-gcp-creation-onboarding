terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0.0"
    }
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

locals {
  cloud_function_zip_path = abspath(var.cloud_function_zip_path)
}

# 1️⃣ Create a GCP Service Account (Read-only Access)
resource "google_service_account" "aws_readonly_sa" {
  account_id   = "aws-readonly-sa"
  display_name = "AWS Read-only Access Service Account"
}

# 2️⃣ Assign Viewer Role to the Service Account
resource "google_project_iam_member" "readonly_binding" {
  project = var.gcp_project_id
  role    = "roles/viewer"
  member  = "serviceAccount:${google_service_account.aws_readonly_sa.email}"
}

# 3️⃣ Create a Workload Identity Pool
resource "google_iam_workload_identity_pool" "aws_pool" {
  workload_identity_pool_id = "aws-pool-mohammad14"
  display_name              = "AWS Workload Identity Pool"
  description               = "Pool to allow AWS access to GCP"
  # Note: optionally specify location = "global" (default) etc.
}

# 4️⃣ Create AWS Provider for the Pool
resource "google_iam_workload_identity_pool_provider" "aws_provider" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.aws_pool.workload_identity_pool_id
  workload_identity_pool_provider_id = "aws-provider"
  display_name                       = "AWS Provider"
  description                        = "Provider for AWS account"

  aws {
    account_id = var.aws_account_id
  }

  attribute_mapping = {
    "google.subject"     = "assertion.arn"
    "attribute.aws_role" = "assertion.arn"
  }

  attribute_condition = "assertion.arn.startsWith('arn:aws:sts::${var.aws_account_id}:assumed-role/${var.aws_role_name}')"
}

# 5️⃣ Allow AWS role to impersonate the GCP service account
resource "google_service_account_iam_binding" "aws_impersonate" {
  service_account_id = google_service_account.aws_readonly_sa.name
  role               = "roles/iam.workloadIdentityUser"

  members = [
    "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.aws_pool.name}/attribute.aws_role/arn:aws:sts::${var.aws_account_id}:assumed-role/${var.aws_role_name}"
  ]
}

# 6️⃣ Grant service account token creator role to the workload identity pool
resource "google_service_account_iam_binding" "token_creator" {
  service_account_id = google_service_account.aws_readonly_sa.name
  role               = "roles/iam.serviceAccountTokenCreator"

  members = [
    "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.aws_pool.name}/*"
  ]
}

# 🔹 Enable required APIs for Cloud Functions (Gen 2)
resource "google_project_service" "cloudfunctions" {
  project = var.gcp_project_id
  service = "cloudfunctions.googleapis.com"
}

resource "google_project_service" "run" {
  project = var.gcp_project_id
  service = "run.googleapis.com"
}

resource "google_project_service" "artifactregistry" {
  project = var.gcp_project_id
  service = "artifactregistry.googleapis.com"
}

# 🔹 Bucket and object to host the Cloud Function source ZIP
resource "google_storage_bucket_object" "function_archive" {
  name   = "extractAndSendGCPInfOoo.zip"
  bucket = var.cloud_function_bucket_name
  source = local.cloud_function_zip_path

  content_type = "application/zip"
}

# 🔹 Cloud Function (Gen 2) deployment equivalent to the gcloud command
resource "google_cloudfunctions2_function" "extract_and_send_info" {
  name        = "extractAndSendGCPInfOoo"
  location    = var.gcp_region
  description = "Extract and send GCP info function deployed via Terraform."

  build_config {
    runtime     = "nodejs20"
    entry_point = "extractAndSendGCPInfo"

    source {
      storage_source {
        bucket = var.cloud_function_bucket_name
        object = google_storage_bucket_object.function_archive.name
      }
    }
  }

  service_config {
    max_instance_count = 3
    available_memory   = "256M"
    ingress_settings   = "ALLOW_ALL"
  }

  depends_on = [
    google_project_service.cloudfunctions,
    google_project_service.run,
    google_project_service.artifactregistry,
  ]
}

resource "google_cloudfunctions2_function_iam_member" "public_invoker" {
  project        = google_cloudfunctions2_function.extract_and_send_info.project
  location       = google_cloudfunctions2_function.extract_and_send_info.location
  cloud_function = google_cloudfunctions2_function.extract_and_send_info.name

  role   = "roles/cloudfunctions.invoker"
  member = "allUsers"
}

# 🔹 Outputs
output "workload_identity_pool_id" {
  value = google_iam_workload_identity_pool.aws_pool.workload_identity_pool_id
}

output "wif_provider_name" {
  value = google_iam_workload_identity_pool_provider.aws_provider.name
}

output "gcp_service_account_email" {
  value = google_service_account.aws_readonly_sa.email
}

output "cloud_function_uri" {
  description = "Invoke URL for the Cloud Function."
  value       = google_cloudfunctions2_function.extract_and_send_info.service_config[0].uri
}




# 🔹 Variables
variable "gcp_project_id" {
  type    = string
  default = "my-project-mohammad-476307"
}

variable "gcp_region" {
  type    = string
  default = "us-central1"
}

variable "aws_account_id" {
  type    = string
  default = "926837946404"
}

variable "aws_role_name" {
  type    = string
  default = "gcpgcp-role-gjwu85iw"
}

variable "cloud_function_zip_path" {
  type        = string
  description = "Relative or absolute path to the ZIP archive containing the Cloud Function source code."
  default     = "function.zip"
}

variable "cloud_function_bucket_name" {
  type        = string
  description = "Name of an existing Cloud Storage bucket where the function source ZIP will be uploaded."
  default     = "gcf-sources-my-project-mohammad-476307"
}
