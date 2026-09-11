; CodeForge Windows installer (Inno Setup 6+)
; Built from the portable VSCode-win32-x64 folder produced by gulp vscode-win32-x64.
;
; Compile via: node scripts/build-installer-windows.mjs
; Or: ISCC.exe build/windows/codeforge.iss

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#ifndef SourceDir
  #define SourceDir "..\..\VSCode-win32-x64"
#endif

#ifndef OutputDir
  #define OutputDir "..\..\dist\codeforge-win32-x64"
#endif

#define MyAppName "CodeForge"
#define MyAppPublisher "Kortexio"
#define MyAppURL "https://github.com/Kortexio/CodeForge"
#define MyAppExeName "CodeForge.exe"
#define MyAppId "{{F8A2A20C-72B3-11EC-90D6-0242AC120003}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=..\..\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename=CodeForge-Setup-{#AppVersion}-win32-x64
SetupIconFile={#SourceDir}\resources\app\resources\win32\code.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
ChangesAssociations=yes
ChangesEnvironment=yes
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Setup
VersionInfoProductName={#MyAppName}
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "portuguese"; MessagesFile: "compiler:Languages\Portuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "addtopath"; Description: "Add CodeForge to PATH (codeforge command)"; GroupDescription: "System:"; Flags: checkedonce

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; URL protocol: codeforge://
Root: HKCU; Subkey: "Software\Classes\codeforge"; ValueType: string; ValueName: ""; ValueData: "URL:CodeForge Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\codeforge"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\codeforge\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\Classes\codeforge\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" --open-url ""%1"""

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER,
    'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Param + ';', ';' + OrigPath + ';') = 0;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  BinPath: string;
  OrigPath: string;
begin
  if CurStep = ssPostInstall then
  begin
    if WizardIsTaskSelected('addtopath') then
    begin
      BinPath := ExpandConstant('{app}\bin');
      if NeedsAddPath(BinPath) then
      begin
        if RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
          RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath + ';' + BinPath)
        else
          RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', BinPath);
      end;
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  BinPath: string;
  OrigPath: string;
  P: Integer;
  NewPath: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    BinPath := ExpandConstant('{app}\bin');
    if RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
    begin
      P := Pos(';' + BinPath, ';' + OrigPath);
      if P > 0 then
      begin
        NewPath := Copy(OrigPath, 1, P - 1) + Copy(OrigPath, P + Length(BinPath) + 1, MaxInt);
        while (Length(NewPath) > 0) and (NewPath[1] = ';') do
          Delete(NewPath, 1, 1);
        RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', NewPath);
      end;
    end;
  end;
end;

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
