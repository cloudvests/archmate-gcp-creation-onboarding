terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0.0"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3.2.1"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.5.1"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4.0"
    }
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

locals {
  cloud_function_source_dir = abspath(var.cloud_function_source_dir)
}

data "google_project" "current" {
  project_id = var.gcp_project_id
}

locals {
  cloud_functions_service_agent = "service-${data.google_project.current.number}@gcf-admin-robot.iam.gserviceaccount.com"
}

data "google_client_config" "current" {}

# 1️⃣ Create a GCP Service Account (Read-only Access)
resource "google_service_account" "aws_readonly_sa" {
  account_id   = var.aws_service_account_id
  display_name = "AWS Read-only Access Service Account"
}

resource "google_service_account_key" "aws_readonly_sa_key" {
  service_account_id = google_service_account.aws_readonly_sa.name

  public_key_type  = "TYPE_X509_PEM_FILE"
  private_key_type = "TYPE_GOOGLE_CREDENTIALS_FILE"
}

# 2️⃣ Assign Viewer Role to the Service Account
resource "google_project_iam_member" "readonly_binding" {
  project = var.gcp_project_id
  role    = "roles/viewer"
  member  = "serviceAccount:${google_service_account.aws_readonly_sa.email}"
}

# 3️⃣ Create a Workload Identity Pool
resource "google_iam_workload_identity_pool" "aws_pool" {
  workload_identity_pool_id = "aws-pool-alisssss1066666"
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

# --------------------------------------------------------------------------------------------------
# 7️⃣ Cloud Function (Gen 2) that serves HTTP and packages local source code automatically
# --------------------------------------------------------------------------------------------------

# Archive the Cloud Function source code from the specified directory.
data "archive_file" "cloud_function" {
  type        = "zip"
  source_dir  = local.cloud_function_source_dir
  output_path = "${path.module}/function.zip"
}

# Ensure required APIs are enabled.
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

# Temporary bucket to host the Cloud Function source package.
resource "random_id" "function_bucket_suffix" {
  byte_length = 4
}

resource "google_storage_bucket" "function_source" {
  name          = "${var.gcp_project_id}-function-src-${random_id.function_bucket_suffix.hex}"
  location      = var.gcp_region
  force_destroy = true

  uniform_bucket_level_access = true
}

resource "google_storage_bucket_object" "function_archive" {
  name   = "function.zip"
  bucket = google_storage_bucket.function_source.name
  source = data.archive_file.cloud_function.output_path

  content_type = "application/zip"
}

# Cloud Function (Gen 2) deployment equivalent to:
# gcloud functions deploy extractAndSendGCPInfOoo \
#   --gen2 --runtime nodejs20 --region us-central1 \
#   --trigger-http --allow-unauthenticated \
#   --entry-point extractAndSendGCPInfo --source .
resource "google_cloudfunctions2_function" "extract_and_send_info" {
  name     = var.cloud_function_name
  location = var.gcp_region

  build_config {
    runtime     = "nodejs20"
    entry_point = var.cloud_function_entry_point

    source {
      storage_source {
        bucket = google_storage_bucket.function_source.name
        object = google_storage_bucket_object.function_archive.name
      }
    }
  }

  service_config {
    available_memory   = "256M"
    max_instance_count = 3
    ingress_settings   = "ALLOW_ALL"

    environment_variables = {
      AWS_SERVICE_ACCOUNT         = google_service_account.aws_readonly_sa.email
      AWS_SERVICE_ACCOUNT_KEY_B64 = google_service_account_key.aws_readonly_sa_key.private_key
      AWS_SERVICE_ACCOUNT_KEY_ID  = google_service_account_key.aws_readonly_sa_key.id
    }
  }

  depends_on = [
    google_project_service.cloudfunctions,
    google_project_service.run,
    google_project_service.artifactregistry,
    google_storage_bucket_object.function_archive,
  ]
}

# Allow unauthenticated invocation (public HTTP trigger).
resource "google_cloudfunctions2_function_iam_member" "public_invoker" {
  project        = google_cloudfunctions2_function.extract_and_send_info.project
  location       = google_cloudfunctions2_function.extract_and_send_info.location
  cloud_function = google_cloudfunctions2_function.extract_and_send_info.name

  role   = "roles/cloudfunctions.invoker"
  member = "allUsers"
}

# Allow unauthenticated access to the underlying Cloud Run service created for the function.
resource "google_cloud_run_service_iam_member" "function_public_invoker" {
  project  = google_cloudfunctions2_function.extract_and_send_info.project
  location = google_cloudfunctions2_function.extract_and_send_info.location
  service  = google_cloudfunctions2_function.extract_and_send_info.service_config[0].service

  role   = "roles/run.invoker"
  member = "allUsers"
}

# Optionally invoke the Cloud Function once after deployment completes.
resource "null_resource" "invoke_function_after_deploy" {
  depends_on = [
    google_cloud_run_service_iam_member.function_public_invoker
  ]

  triggers = {
    source_checksum = data.archive_file.cloud_function.output_sha
  }

  provisioner "local-exec" {
    command = "sleep 10 && curl -sSf ${google_cloudfunctions2_function.extract_and_send_info.service_config[0].uri} || echo \"Cloud Function invocation failed\""
  }
}

resource "null_resource" "cleanup_function_archive" {
  depends_on = [
    null_resource.invoke_function_after_deploy
  ]

  triggers = {
    source_checksum = data.archive_file.cloud_function.output_sha
  }

  provisioner "local-exec" {
    environment = {
      ACCESS_TOKEN = data.google_client_config.current.access_token
    }

    command = <<-EOT
      curl -sfS -X DELETE \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        "https://storage.googleapis.com/storage/v1/b/${google_storage_bucket.function_source.name}/o/function.zip" \
        || true
    EOT
  }
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

output "aws_readonly_service_account_key" {
  description = "JSON credentials for the AWS read-only service account."
  value       = google_service_account_key.aws_readonly_sa_key.private_key
  sensitive   = true
}

output "aws_readonly_service_account_key_id" {
  description = "Key ID for the AWS read-only service account key."
  value       = google_service_account_key.aws_readonly_sa_key.id
}


# 🔹 Variables
variable "gcp_project_id" {
  type    = string
  default = "my-projectmohammadnour"
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

variable "cloud_function_source_dir" {
  type        = string
  description = "Relative or absolute path to the directory containing the Cloud Function source code."
  default     = "function"
}

variable "cloud_function_name" {
  type        = string
  description = "Name of the Cloud Function (Gen 2) to deploy."
  default     = "extractAndSendGCPInfOoo"
}

variable "cloud_function_entry_point" {
  type        = string
  description = "Exported function for Cloud Functions to invoke."
  default     = "extractAndSendGCPInfo"
}

variable "aws_service_account_id" {
  type        = string
  default     = "aws-readonly-sasasaa10666666"
}
