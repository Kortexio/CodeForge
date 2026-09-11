triggers: [dotnet, csharp, razor, blazor, aspnet, ef core]

# .NET / Razor conventions

- Pick ONE stack: Razor Pages (`Pages/` + `@page` first) OR MVC (`Views/` + Controllers). Never mix mid-task.
- Models in Models/, services in Services/, DI in Program.cs.
- Validation: ValidationMessageFor / asp-validation-for (not ValidationFor).
- EF packages must match TFM; add one package at a time.
- After edits: `dotnet build` on the .csproj and fix CS/RZ errors before new features.
