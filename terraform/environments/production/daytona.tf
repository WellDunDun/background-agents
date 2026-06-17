# =============================================================================
# Daytona Sandbox Infrastructure
# =============================================================================

# Calculate hash of Daytona snapshot source files for change detection.
# Includes daytona-infra, sandbox-runtime, and flue-runtime copied into the image.
data "external" "daytona_source_hash" {
  count = local.use_daytona_backend ? 1 : 0

  program = ["bash", "-c", <<-EOF
    cd ${var.project_root}
    if command -v sha256sum &> /dev/null; then
      hash=$(find packages/daytona-infra/src packages/sandbox-runtime/src packages/flue-runtime/src packages/flue-runtime/flue.config.ts packages/flue-runtime/package.json packages/flue-runtime/package-lock.json \
        -type f \( -name "*.py" -o -name "*.js" -o -name "*.ts" -o -name "package.json" -o -name "package-lock.json" \) \
        -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1)
    else
      hash=$(find packages/daytona-infra/src packages/sandbox-runtime/src packages/flue-runtime/src packages/flue-runtime/flue.config.ts packages/flue-runtime/package.json packages/flue-runtime/package-lock.json \
        -type f \( -name "*.py" -o -name "*.js" -o -name "*.ts" -o -name "package.json" -o -name "package-lock.json" \) \
        -exec shasum -a 256 {} \; | sort | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "daytona_infra" {
  count  = local.use_daytona_backend ? 1 : 0
  source = "../../modules/daytona-infra"

  api_key       = var.daytona_api_key
  api_url       = var.daytona_api_url
  target        = var.daytona_target
  snapshot_name = var.daytona_base_snapshot
  deploy_path   = "${var.project_root}/packages/daytona-infra"
  source_hash   = data.external.daytona_source_hash[0].result.hash
}
