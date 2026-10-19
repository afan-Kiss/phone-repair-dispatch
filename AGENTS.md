# 项目协作说明

在本项目中进行设计、编码、测试或修改业务流程前，先阅读 [项目边界.md](项目边界.md)。其中的 V1.0 业务规则和验收标准是当前项目边界；涉及金额、结算、权限、转派及审计的实现应与其保持一致。未确定的业务细节应明确标注为待确认，不要自行当作既定规则。

## GitHub 推送

项目已保存 GitHub Personal Access Token，**推送时不要再向用户索要 token**。

- 凭据：根目录 `.github-credentials`（`api_key=...`，仅本地保存，已加入 `.gitignore` 不推送到 GitHub）
- 推送：在项目根目录执行 `.\scripts\push-github.ps1`（可附加 `git push` 参数）
- 未配置远程时先 `git remote add origin https://github.com/<用户>/<仓库>.git`
