#!/usr/bin/env bash
set -euo pipefail

commit=fbbdb23c86627c18b859369b19746a9245f1ce0b
source_url=https://github.com/open-jarvis/OpenJarvis.git
install_root="${HOME}/.local/share/agentimpact-openjarvis"
config_root="${HOME}/.openjarvis"
adapter_root="${config_root}/agentimpact"
bin_root="${HOME}/.local/bin"
script_root="$(cd "$(dirname "$0")" && pwd)"

test "$(uname -s)" = Darwin || { echo 'macOS is required' >&2; exit 2; }
command -v git >/dev/null
command -v uv >/dev/null || { echo 'Install uv from https://docs.astral.sh/uv/ first' >&2; exit 2; }
test -f "${adapter_root}/operator.env" || {
  echo "Missing ${adapter_root}/operator.env; install the operator token with mode 0600 first." >&2
  exit 3
}
test "$(stat -f '%Lp' "${adapter_root}/operator.env")" = 600 || {
  echo 'operator.env must have mode 0600' >&2; exit 3;
}

mkdir -p "$(dirname "$install_root")" "$adapter_root" "$bin_root"
if [ -d "${install_root}/.git" ]; then
  test "$(git -C "$install_root" config --get remote.origin.url)" = "$source_url"
  git -C "$install_root" fetch --prune origin
else
  git clone "$source_url" "$install_root"
fi
git -C "$install_root" checkout --detach "$commit"
test "$(git -C "$install_root" rev-parse HEAD)" = "$commit"

(cd "$install_root" && uv sync --extra server)

for file in config.toml mcp-servers.json; do
  if [ -e "${config_root}/${file}" ]; then
    cp -p "${config_root}/${file}" "${config_root}/${file}.pre-agentimpact"
  fi
  install -m 0600 "${script_root}/${file}" "${config_root}/${file}"
done
if [ -e "${adapter_root}/capabilities.json" ]; then
  cp -p "${adapter_root}/capabilities.json" "${adapter_root}/capabilities.json.pre-agentimpact"
fi
install -m 0600 "${script_root}/capabilities.json" "${adapter_root}/capabilities.json"
install -m 0700 "${script_root}/agentimpact_mcp.py" "${bin_root}/agentimpact-openjarvis-mcp"
install -m 0700 "${script_root}/agentimpact_mcp.py" "${install_root}/.venv/bin/agentimpact-openjarvis-mcp"
install -m 0600 "${script_root}/agentimpact_mcp.py" "${install_root}/.venv/bin/agentimpact_mcp.py"
install -m 0700 "${script_root}/confirm.py" "${install_root}/.venv/bin/agentimpact-openjarvis-confirm"
ln -sfn "${install_root}/.venv/bin/agentimpact-openjarvis-confirm" "${bin_root}/agentimpact-openjarvis-confirm"
install -m 0700 "${script_root}/agentimpact-openjarvis" "${bin_root}/agentimpact-openjarvis"

echo "OpenJarvis pinned at ${commit}."
echo "Start: ${bin_root}/agentimpact-openjarvis serve --host 127.0.0.1 --port 8000"
