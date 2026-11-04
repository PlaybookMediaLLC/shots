import { getRolePermissions, hasPermission, organizationRoles } from '@/lib/auth/permissions'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { roleCapabilities, roleLabels, roleSummaries } from '@/lib/auth/role-descriptions'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function WorkspaceRolesSettings() {
  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground">
        Choose the smallest role that covers a teammate’s work. Change roles in Members.
      </p>
      <div className="overflow-x-auto rounded-xl border border-border">
        <Table className="w-full text-left text-sm">
          <TableCaption className="sr-only">Workspace role capabilities</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead
                className="p-4 align-bottom text-xs font-medium whitespace-normal text-muted-foreground"
                scope="col"
              >
                Role
              </TableHead>
              {roleCapabilities.map(({ label }) => (
                <TableHead
                  className="p-4 align-bottom text-xs font-medium whitespace-normal text-muted-foreground"
                  scope="col"
                  key={label}
                >
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {organizationRoles.map((role) => (
              <TableRow className="border-t border-border" key={role}>
                <TableHead
                  className="min-w-56 max-w-72 p-4 font-normal whitespace-normal"
                  scope="row"
                >
                  <span className="font-medium capitalize">{roleLabels[role]}</span>
                  <p className="mt-1 text-xs text-muted-foreground">{roleSummaries[role]}</p>
                </TableHead>
                {roleCapabilities.map(({ permission }) => (
                  <TableCell className="p-4" key={permission}>
                    {hasPermission(role, permission) ? 'Yes' : '—'}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Disclosure className="text-sm text-muted-foreground">
        <DisclosureTrigger>Technical permission details</DisclosureTrigger>
        <DisclosureContent>
          {organizationRoles.map((role) => (
            <p className="mt-3" key={role}>
              <strong className="capitalize">{roleLabels[role]}: </strong>
              {getRolePermissions(role).join(', ')}
            </p>
          ))}
        </DisclosureContent>
      </Disclosure>
    </div>
  )
}
