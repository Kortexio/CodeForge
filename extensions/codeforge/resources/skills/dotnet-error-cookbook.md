---
name: .NET error cookbook
description: Fixes for common CS / NU / MSB / NETSDK build errors
triggers: [error cs, build error, erro de build, erro de compilação, cookbook, nu1101, msb1011]
---
Fix the first error of each file first; later errors are often a cascade.

- CS0246 type or namespace not found → add the `using`, or the ProjectReference to the project that defines it; check the exact type name.
- CS0234 namespace does not exist in namespace → the namespace in the file differs from the one used; align them.
- CS0103 name does not exist in the current context → typo, missing field/local, or a method in another class (qualify it).
- CS1061 type has no member → the member name differs, or the member is on another type; confirm with symbols/definition.
- CS0101 namespace already contains a definition → two files define the same type; delete or merge one.
- CS0111 member already defined → duplicate method with the same signature in the class.
- CS0117 type does not contain a definition → static member name is wrong.
- CS1002 ; expected / CS1513 } expected → syntax: an unclosed brace or statement just above the reported line.
- CS0029 / CS0266 cannot convert type → add an explicit conversion, or change the declared type.
- CS8618 non-nullable property uninitialized (warning) → `required`, an initializer, or a constructor assignment.
- CS0535 does not implement interface member → add the member with the exact signature.
- CS7036 no argument for required parameter → pass the argument, or add an overload / default value.
- NU1101 package not found → wrong package id; check the exact name.
- NU1102 package version not found → pick an existing version or omit `version`.
- NU1605 package downgrade → align the versions of the same package across projects.
- MSB1011 more than one project or solution file → pass the .slnx/.sln/.csproj path explicitly.
- MSB1009 project file does not exist → the path is wrong; paths are relative to the workspace root.
- MSB3202 project file not found (restore) → a ProjectReference points to a missing path; fix the relative path.
- NETSDK1045 SDK does not support the target framework → use a TargetFramework the installed SDK supports (e.g. net10.0).
- NETSDK1004 assets file not found → run `dotnet restore` (or build) on the solution.
