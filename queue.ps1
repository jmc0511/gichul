# 기출 출제실 대기열 도구 (소유자 PC 전용)
#   .\queue.ps1 list                  대기 중인 요청 목록
#   .\queue.ps1 watch [초]             요청이 생길 때까지 기다림 (기본 60초 간격)
#   .\queue.ps1 claim <id>            요청을 '출제 중'으로 바꾸고 자료를 work\<id>.txt 로 저장
#   .\queue.ps1 done <id> <exam.json> 시험지를 올리고 요청을 '완료'로 바꿈
#   .\queue.ps1 fail <id> <사유>       요청을 '실패'로 바꿈
# secret.json: { "url": "https://xxxx.supabase.co", "key": "<secret 또는 service_role 키>" }

param([Parameter(Mandatory = $true)][string]$Cmd, [string]$Id, [string]$Arg)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content (Join-Path $here "secret.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$base = $cfg.url.TrimEnd("/") + "/rest/v1"
$headers = @{ apikey = $cfg.key; Prefer = "return=representation" }
if ($cfg.key.StartsWith("eyJ")) { $headers.Authorization = "Bearer " + $cfg.key }
$utf8 = New-Object Text.UTF8Encoding $false

function Call($method, $path, $body) {
  # 기본 User-Agent(Mozilla…)면 Supabase가 브라우저로 보고 비밀 키를 거부함
  $p = @{ Method = $method; Uri = $base + $path; Headers = $headers; ContentType = "application/json; charset=utf-8"; UserAgent = "gichul-queue/1.0" }
  if ($null -ne $body) { $p.Body = $utf8.GetBytes(($body | ConvertTo-Json -Depth 30 -Compress)) }
  Invoke-RestMethod @p
}

switch ($Cmd) {
  "list" {
    $rows = Call GET "/requests?status=eq.pending&select=id,created_at,subject,files,pages&order=created_at.asc" $null
    if (-not $rows) { "대기 중인 요청 없음"; break }
    $rows | ForEach-Object { "{0}  {1}  {2}쪽  {3}" -f $_.id, $_.created_at, $_.pages, ($(if ($_.subject) { $_.subject } else { $_.files -join ", " })) }
  }
  "watch" {
    # 요청이 들어올 때까지 조용히 기다렸다가, 생기면 목록을 출력하고 끝남 (AI 사용량 0)
    $sec = if ($Id) { [int]$Id } else { 60 }
    while ($true) {
      try {
        $rows = Call GET "/requests?status=eq.pending&select=id,created_at,subject,files,pages&order=created_at.asc" $null
        if ($rows) {
          "새 요청 $(@($rows).Count)개"
          $rows | ForEach-Object { "{0}  {1}  {2}쪽  {3}" -f $_.id, $_.created_at, $_.pages, ($(if ($_.subject) { $_.subject } else { $_.files -join ", " })) }
          break
        }
      } catch { }
      Start-Sleep -Seconds $sec
    }
  }
  "claim" {
    $r = Call PATCH "/requests?id=eq.$Id&status=eq.pending" @{ status = "working" }
    if (-not $r) { throw "요청 $Id 을(를) 가져올 수 없음 (이미 처리 중이거나 없음)" }
    $row = (Call GET "/requests?id=eq.$Id&select=instructions,material" $null)[0]
    $dir = Join-Path $here "work"; New-Item -ItemType Directory -Force $dir | Out-Null
    $out = Join-Path $dir "$Id.txt"
    [IO.File]::WriteAllText($out, $row.instructions + "`n`n[공부자료 원문]`n" + $row.material, $utf8)
    "자료 저장: $out"
  }
  "done" {
    $exam = [IO.File]::ReadAllText((Resolve-Path $Arg), $utf8) | ConvertFrom-Json
    if (-not $exam.questions -or @($exam.questions).Count -eq 0) { throw "questions 가 비어 있음" }
    $row = @{ request_id = $Id; title = [string]$exam.title; subject = [string]$exam.subject; questions = @($exam.questions) }
    $saved = (Call POST "/exams" $row)[0]
    Call PATCH "/requests?id=eq.$Id" @{ status = "done"; exam_id = $saved.id; material = "" } | Out-Null
    "완료: 시험지 $($saved.id) ($(@($exam.questions).Count)문항)"
  }
  "fail" {
    Call PATCH "/requests?id=eq.$Id" @{ status = "error"; error = $Arg } | Out-Null
    "실패 처리: $Id"
  }
  default { throw "알 수 없는 명령: $Cmd (list | watch | claim | done | fail)" }
}
