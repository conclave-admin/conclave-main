import { Link } from 'react-router-dom';
import ThemeSwitch from '@/components/ui/ThemeSwitch';
import Logo from './Logo';

export default function LandingFooter() {
  return (
    <footer className="cl-footer cl-container">
      <div className="cl-footer-top">
        <div className="cl-footer-brand">
          <Link to="/" aria-label="Conclave home"><Logo /></Link>
          <p>Good conversations.<br />Great possibilities.</p>
        </div>
        <nav className="cl-footer-nav" aria-label="Footer">
          <div><p>Explore</p><a href="#features">Why Conclave</a><a href="#product-preview">A look inside</a><Link to="/register">Get started</Link></div>
          <div><p>The details</p><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link><Link to="/pricing">Pricing</Link></div>
        </nav>
      </div>
      <div className="cl-footer-bottom">
        <p>© {new Date().getFullYear()} Conclave. A place for your people.</p>
        <ThemeSwitch compact />
      </div>
    </footer>
  );
}
