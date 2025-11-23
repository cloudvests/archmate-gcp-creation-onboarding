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
resource "random_id" "service_account_suffix" {
  byte_length = 2
}

resource "google_service_account" "aws_readonly_sa" {
  account_id   = "${var.aws_service_account_id}-${random_id.service_account_suffix.hex}"
  display_name = "Archmate AWS Read-only Access Service Account"
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
resource "random_id" "pool_suffix" {
  byte_length = 2
}

resource "google_iam_workload_identity_pool" "aws_pool" {
  workload_identity_pool_id = "archmate-aws-pool-read-only-${random_id.pool_suffix.hex}"
  display_name              = "AWS Workload Identity Pool"
  description               = "Pool to allow AWS access to GCP"
  # Note: optionally specify location = "global" (default) etc.
}

# 4️⃣ Create AWS Provider for the Pool
resource "google_iam_workload_identity_pool_provider" "aws_provider" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.aws_pool.workload_identity_pool_id
  workload_identity_pool_provider_id = "archmate-aws-provider"
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

resource "google_project_service" "eventarc" {
  project = var.gcp_project_id
  service = "eventarc.googleapis.com"
}

resource "google_project_service" "cloudasset" {
  project = var.gcp_project_id
  service = "cloudasset.googleapis.com"
}

resource "google_project_service" "logging" {
  project = var.gcp_project_id
  service = "logging.googleapis.com"
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
resource "random_id" "cloud_function_suffix" {
  byte_length = 2
}

resource "google_cloudfunctions2_function" "extract_and_send_info" {
  name     = "${var.cloud_function_name}-${random_id.cloud_function_suffix.hex}"
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
      COGNITO_TOKEN_URL           = var.cognito_token_url
      COGNITO_CLIENT_ID           = var.cognito_client_id
      COGNITO_CLIENT_SCOPE        = var.cognito_client_scope
      COGNITO_CLIENT_SECRET_B64   = var.cognito_client_secret_b64
      AWS_API_KEY                 = var.aws_api_key
      AWS_ENDPOINT                = var.aws_endpoint
      AWS_ENDPOINT_PATH           = var.aws_endpoint_path
      # EVENTTYPE                   = var.eventtype
      # VERSION                     = var.version
    }
  }

  depends_on = [
    google_project_service.cloudfunctions,
    google_project_service.run,
    google_project_service.artifactregistry,
    google_project_service.eventarc,
    google_project_service.cloudasset,
    google_project_service.logging,
    google_storage_bucket_object.function_archive,
  ]
}

# Eventarc trigger for resource creation events (listens to Audit Logs)
resource "google_eventarc_trigger" "resource_create" {
  name     = "${lower(var.cloud_function_name)}-create-${random_id.cloud_function_suffix.hex}"
  location = var.gcp_region
  project  = var.gcp_project_id

  matching_criteria {
    attribute = "type"
    value     = "google.cloud.audit.log.v1.written"
  }

  matching_criteria {
    attribute = "methodName"
    value     = "google.cloud.resourcemanager.v3.Projects.CreateProject"
  }

  destination {
    cloud_run_service {
      service = google_cloudfunctions2_function.extract_and_send_info.service_config[0].service
      region  = var.gcp_region
    }
  }

  service_account = google_service_account.aws_readonly_sa.email

  depends_on = [
    google_project_service.eventarc,
    google_cloudfunctions2_function.extract_and_send_info,
  ]
}

# Eventarc trigger for resource update events
resource "google_eventarc_trigger" "resource_update" {
  name     = "${lower(var.cloud_function_name)}-update-${random_id.cloud_function_suffix.hex}"
  location = var.gcp_region
  project  = var.gcp_project_id

  matching_criteria {
    attribute = "type"
    value     = "google.cloud.audit.log.v1.written"
  }

  matching_criteria {
    attribute = "methodName"
    value     = "google.cloud.resourcemanager.v3.Projects.UpdateProject"
  }

  destination {
    cloud_run_service {
      service = google_cloudfunctions2_function.extract_and_send_info.service_config[0].service
      region  = var.gcp_region
    }
  }

  service_account = google_service_account.aws_readonly_sa.email

  depends_on = [
    google_project_service.eventarc,
    google_cloudfunctions2_function.extract_and_send_info,
  ]
}

# Eventarc trigger for resource deletion events
resource "google_eventarc_trigger" "resource_delete" {
  name     = "${lower(var.cloud_function_name)}-delete-${random_id.cloud_function_suffix.hex}"
  location = var.gcp_region
  project  = var.gcp_project_id

  matching_criteria {
    attribute = "type"
    value     = "google.cloud.audit.log.v1.written"
  }

  matching_criteria {
    attribute = "methodName"
    value     = "google.cloud.resourcemanager.v3.Projects.DeleteProject"
  }

  destination {
    cloud_run_service {
      service = google_cloudfunctions2_function.extract_and_send_info.service_config[0].service
      region  = var.gcp_region
    }
  }

  service_account = google_service_account.aws_readonly_sa.email

  depends_on = [
    google_project_service.eventarc,
    google_cloudfunctions2_function.extract_and_send_info,
  ]
}

# Grant Eventarc service account permission to invoke the function
resource "google_cloudfunctions2_function_iam_member" "eventarc_invoker" {
  project        = google_cloudfunctions2_function.extract_and_send_info.project
  location       = google_cloudfunctions2_function.extract_and_send_info.location
  cloud_function = google_cloudfunctions2_function.extract_and_send_info.name
  role           = "roles/cloudfunctions.invoker"
  member         = "serviceAccount:${google_service_account.aws_readonly_sa.email}"
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
  description = "JSON credentials for the archmate AWS read-only service account."
  value       = google_service_account_key.aws_readonly_sa_key.private_key
  sensitive   = true
}

output "aws_readonly_service_account_key_id" {
  description = "Key ID for the archmate AWS read-only service account key."
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
  default     = "archmate-extractAndSendGCPInfo"
}

variable "cloud_function_entry_point" {
  type        = string
  description = "Exported function for Cloud Functions to invoke."
  default     = "archmateExtractAndSendGCPInfo"
}

variable "aws_service_account_id" {
  type        = string
  default     = "archmate-aws-readonly"
}

variable "aws_api_key" {
  type        = string
  description = "Optional API key header value for the AWS endpoint."
  default     = ""
  sensitive   = true
}

variable "aws_endpoint" {
  type        = string
  description = "Base URL of the AWS API endpoint to call."
  default     = "https://zspu86b2d7.execute-api.eu-central-1.amazonaws.com"
}

variable "aws_endpoint_path" {
  type        = string
  description = "Optional path to append to the AWS endpoint base URL."
  default     = "/dev/run-assessment"
}

variable "cognito_token_url" {
  type        = string
  description = "Amazon Cognito OAuth2 token endpoint URL. Format: https://<your-user-pool-domain>.auth.eu-central-1.amazoncognito.com/oauth2/token"
  default     = "https://eu-central-1yxgmmtmcl.auth.eu-central-1.amazoncognito.com/oauth2/token"
}

variable "cognito_client_id" {
  type        = string
  description = "Cognito app client ID used for client credentials flow."
  default     = "279kthrmc1kbopa1j95tlkf3gq"
}

variable "cognito_client_scope" {
  type        = string
  description = "Scope requested during Cognito client credentials flow."
  default     = "default-m2m-resource-server--9rac1/gcp-onboarding-read"
}

variable "cognito_client_secret_b64" {
  type        = string
  description = "Base64-encoded Cognito client secret (will be decoded in the function)."
  default     = "YnE1OXVsZHBndmU1NjNoaGVmcmdwdHEzazdtZm1sODN0a2syZW9xbTFxcGZwZm40am1s"
  sensitive   = true
}

# variable "eventtype" {
#   type        = string
#   description = "Event type to be sent to the cloud function."
#   default     = "creation"
# }

# variable "version" {
#   type        = string
#   description = "Version of the cloud function."
#   default     = "1.0.0"
# }