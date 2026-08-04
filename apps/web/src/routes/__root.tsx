import { createRootRoute, Link, Outlet, useLocation } from '@tanstack/react-router';
import { useStore } from '../stores/provision.store';

function Root() {
  const { isAuthenticated, logout } = useStore();
  const { pathname } = useLocation();

  if (!isAuthenticated) {
    return <Outlet />;
  }

  const NavLink = ({ to, children }: { to: string; children: React.ReactNode }) => {
    const active = pathname === to || (to !== '/' && pathname.startsWith(to));
    return (
      <Link
        to={to}
        className={`block px-4 py-2.5 text-sm font-sans font-medium rounded-button transition-all duration-150 ${
          active
            ? 'bg-[#1E2D4A] text-white shadow-sm'
            : 'text-gray-300 hover:bg-[#15233B] hover:text-white'
        }`}
      >
        {children}
      </Link>
    );
  };

  const reviewActive = pathname === '/review' || pathname.startsWith('/runs');

  return (
    <div className="min-h-screen flex bg-taxpro-bg font-sans text-taxpro-navy">
      {/* Enterprise Deep Navy Sidebar */}
      <aside className="w-64 bg-[#0A192F] border-r border-[#1E2D4A] p-5 flex flex-col justify-between">
        <div>
          <div className="mb-8 border-b border-[#1E2D4A] pb-5">
            <h1 className="text-2xl font-serif font-semibold text-white tracking-tight leading-tight">
              TaxPro
            </h1>
            <p className="text-xs text-gray-400 font-sans tracking-wide mt-0.5">
              UK FRS 102 Tax Provision
            </p>
          </div>

          <nav className="flex flex-col gap-1.5">
            <NavLink to="/">Dashboard</NavLink>
            <NavLink to="/connections">Data Sources</NavLink>
            <NavLink to="/periods">Periods</NavLink>
            <NavLink to="/documents">Documents</NavLink>
            <NavLink to="/mapping">Tax Mapping</NavLink>
            <NavLink to="/governance">Proposals & Rules</NavLink>
            <NavLink to="/workbench">Workbench</NavLink>
            <NavLink to="/provision">Provision</NavLink>
            <Link
              to="/review"
              className={`block px-4 py-2.5 text-sm font-sans font-medium rounded-button transition-all duration-150 ${
                reviewActive
                  ? 'bg-[#1E2D4A] text-white shadow-sm'
                  : 'text-gray-300 hover:bg-[#15233B] hover:text-white'
              }`}
            >
              Review Queue
            </Link>
            <NavLink to="/review-items">Review Items</NavLink>
          </nav>
        </div>

        <div className="pt-4 border-t border-[#1E2D4A]">
          <button
            onClick={logout}
            className="w-full text-left px-4 py-2 text-xs font-sans font-medium text-gray-400 hover:text-red-400 hover:bg-[#15233B] rounded-button transition-colors"
          >
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content Workspace */}
      <main className="flex-1 p-8 overflow-auto bg-taxpro-bg">
        <Outlet />
      </main>
    </div>
  );
}

function ErrorBoundary({ error }: { error: Error }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-taxpro-bg">
      <div className="bg-white rounded-card border border-red-200 p-8 max-w-md text-center shadow-sm">
        <h2 className="text-xl font-serif font-semibold text-red-700 mb-2">Something went wrong</h2>
        <p className="text-sm font-sans text-red-600 mb-4">{error.message}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-[#0A192F] text-white rounded-button text-sm font-medium hover:bg-[#112240] transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  component: Root,
  errorComponent: ErrorBoundary,
});
