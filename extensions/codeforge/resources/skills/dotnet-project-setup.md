---
name: .NET project setup
description: Create solution, classlib/xunit projects, references and Directory.Build.props with the dotnet tool
triggers: [csproj, classlib, xunit project, dotnet new, solution, slnx, sln, Directory.Build.props, scaffold, projeto .net, criar solution]
---
Use the `dotnet` tool from the workspace root (paths relative to the root):

```
dotnet {action:"new", template:"sln", name:"Acme.App"}                       → Acme.App.slnx
dotnet {action:"new", template:"classlib", name:"Acme.App.Domain", output:"src/Acme.App.Domain", framework:"net10.0"}
dotnet {action:"new", template:"xunit", name:"Acme.App.Tests", output:"tests/Acme.App.Tests", framework:"net10.0"}
dotnet {action:"sln_add", solution:"Acme.App.slnx", project:"src/Acme.App.Domain/Acme.App.Domain.csproj"}
dotnet {action:"add_reference", project:"tests/Acme.App.Tests/Acme.App.Tests.csproj", reference:"src/Acme.App.Domain/Acme.App.Domain.csproj"}
```

`dotnet new` templates create `Class1.cs` / `UnitTest1.cs`; delete them once real files exist.

Directory.Build.props at the root (applies to every project):

```xml
<Project>
  <PropertyGroup>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```
